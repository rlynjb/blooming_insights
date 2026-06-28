# 06 — The eval flywheel
*Industry name: continuous evaluation loop / quality regression harness. Type: Industry standard / AI-engineering (Case B framing: shipped + used + retired with PR #8 on 2026-06-18; not in this repo today).*

## A reality-check before the walkthrough

**The repo does not have an `eval/` directory today.** This file is
the audit-trail for an eval pipeline that **existed**, **caught real
bugs**, and was **retired deliberately** when the data substrate it
ran against was removed. It belongs in the study because the
discipline transfers — and because pretending the eval is live would
collapse under the first interview question that asks to see the
directory.

Case B framing throughout: the four-pillar pattern is real; the
substrate (the Olist e-commerce data + the `mcp-server-olist` sibling
repo) is gone since PR #8 on 2026-06-18; the pipeline retired with
the substrate. Honest claim: "I shipped a four-pillar eval harness
that caught a real currency-rounding bug before merge. When PR #8
removed the substrate, I retired the eval too — rebuilding it on
Bloomreach data is a known move I haven't prioritized." Dishonest
claim: "the repo has an eval pipeline." It doesn't.

## Zoom out — where the flywheel would live

```
  the four-pillar eval flywheel (NOT IN REPO TODAY)

  ┌─ Agent layer (REAL TODAY) ───────────────────────────────────────┐
  │  MonitoringAgent / DiagnosticAgent / RecommendationAgent          │
  └─────────────────────────────┬────────────────────────────────────┘
                                │  exercised by:
  ┌─ Eval harness (RETIRED) ────▼────────────────────────────────────┐
  │                                                                   │
  │   ┌─ pillar 1 ─────────────┐  ┌─ pillar 2 ──────────────────────┐│
  │   │ GOLD DATASET            │  │ LLM-AS-JUDGE                    ││
  │   │ ~30 (input, expected,   │  │ calibrated by K=10 human spot-  ││
  │   │  human_verdict) entries │  │ check → structured verdicts     ││
  │   └────────────┬────────────┘  └────────────┬────────────────────┘│
  │                │                              │                    │
  │                └──────────────┬───────────────┘                    │
  │                               ▼                                    │
  │   ┌─ pillar 3 ─────────────┐  ┌─ pillar 4 ──────────────────────┐│
  │   │ CATEGORY COVERAGE GATE  │  │ BRL CURRENCY SENTINEL           ││
  │   │ every anomaly category  │  │ specific gold-set entry; revenue ││
  │   │ seen ≥ 1× per eval run  │  │ off by > $0.01 fails the run    ││
  │   └────────────┬────────────┘  └────────────┬────────────────────┘│
  │                │                              │                    │
  │                └──────────────┬───────────────┘                    │
  │                               ▼                                    │
  │                     PASS / FAIL → CI gate, merge blocked on red    │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  feeds back into:
  ┌─ Prompt + agent code (REAL) ──▼──────────────────────────────────┐
  │  lib/agents/legacy-prompts/*.md ← tuned in response to eval signal│
  │  lib/agents/legacy-validate.ts  ← gate hardened when judge flags  │
  │                                    a new failure mode             │
  └───────────────────────────────────────────────────────────────────┘
                                  │
                                  └──────────► FLYWHEEL
                                               every red eval is a
                                               prompt iteration that
                                               makes the next eval less
                                               red, until the gate is
                                               stable enough to ship
```

The **flywheel** is the feedback loop: eval surfaces a regression →
prompt is tuned → next eval is greener → over time the suite becomes
the regression record. The four pillars are what made each pass of
the wheel produce a meaningful signal.

## Structure pass — the skeleton this pattern hangs on

**Layers:** prompt → agent → eval harness → CI gate → human iterates.

**Axis: failure containment — where does a regression get caught?**

```
  failure containment across the layers

  no eval                                with the four-pillar eval
  ─────────────────────────              ───────────────────────────
  regression surfaces in PROD            regression surfaces at CI
   (a user notices the agent              (the eval run fails, the
    started returning wrong               merge is blocked, the
    severity)                             engineer iterates on the
                                          prompt BEFORE shipping)
  recovery: incident, rollback           recovery: one prompt edit,
                                          re-run, ship
  catch latency: hours-to-days           catch latency: minutes
```

Each pillar shifts a class of regression earlier in the lifecycle.
The flywheel is what compounds that — every regression caught is also
a learning, and the prompt evolves in response.

**The seams that matter:**

  → pillar 1 ↔ pillar 2 — the gold set IS the judge's calibration set
  → pillar 2 ↔ pillar 3 — coverage gate sits ALONGSIDE the judge so
    a high score on a tiny subset doesn't pass
  → pillar 1 ↔ pillar 4 — the sentinel is one specific gold-set entry
    with a hand-tuned threshold around a known bug class
  → all four ↔ CI — without the merge gate the flywheel doesn't spin

## How it works

### Move 1 — the mental model

You know how `git bisect` lets you find the commit that broke a test?
Same shape one altitude up: the eval harness lets you find the prompt
change that broke an output quality. The four pillars are the things
that have to be in place for "broke an output quality" to mean
something concrete rather than "the team has a vague sense the agent
is worse this week."

```
  the flywheel — one turn

       prompt v_N
            │
            │  agent run on gold set
            ▼
       outputs v_N
            │
            │  judge scores each
            ▼
       verdicts v_N
            │
            │  coverage + sentinel gates check
            ▼
       PASS or FAIL
        │       │
   ship │       │ block merge
        │       │
        │       │  human reads judge reasoning,
        │       │  identifies the regression class
        │       │
        │       ▼
        │   prompt v_{N+1}  ← iterate, re-run
        │       │
        └───────┼──────────► next gold-set entry added
                ▼                (the flywheel grows the set
            prompt v_N            with each regression class
                                  encountered)
```

Every red pass is a learning that becomes the next test. That's why
it's a **flywheel** and not a one-shot check — the suite GROWS as
the agent matures.

### Move 2 — the step-by-step walkthrough

#### Step 1 — pillar 1: the gold dataset

A small set of (input, agent_output, human_verdict) entries. The
Olist-era set was ~30 entries, covering:

```
  gold-set composition (illustrative reconstruction of the
  retired Olist-era set):

  category                              n  what each entry pinned
  ───────────────────────────────       ─  ─────────────────────────────
  obvious anomaly (≥30% drop)           8  baseline catches that EVERY
                                            iteration must clear
  subtle anomaly (~10-15% drop)         6  the prompt's threshold
                                            calibration
  no-anomaly noise (random 5-10%        4  false-positive prevention
   week-over-week variance)
  segment-specific (one country         5  scope-specificity correctness
   drops, global is fine)
  multi-cause (two metrics move          3  hypothesis enumeration
   in unrelated ways same week)
  currency edge cases (BRL, JPY,        4  ← pillar 4 anchors here
   small-denomination units)
                                       ──
                                       30
```

The set was hand-built; each entry was hand-judged. The human-judged
verdict was the ground truth. Total time to build: a working day,
spread across two engineers cross-checking each other.

The **gold set IS the contract** between the eval pipeline and the
team's understanding of "what good looks like." Every regression
class adds an entry. Every entry adds a guarantee that future
prompts can't backslide on it.

#### Step 2 — pillar 2: the calibrated judge

The judge LLM + the rubric prompt + the calibration set. The full
walkthrough lives in `05-llm-as-judge-as-testing.md` — the short
version for the flywheel context:

```
  the judge in 4 facts:
  1. it's a separate LLM call (not the agent under test)
  2. it scores against a 5±2 criterion rubric
  3. it returns structured JSON (the test asserts on the JSON shape)
  4. it's calibrated against the gold set by K=10 human spot-checks
     before being trusted as an oracle
```

The judge alone isn't an eval — it's just a quality scorer. The judge
**inside the four-pillar harness** becomes an eval because the other
three pillars wrap it: the gold set gives it inputs, the coverage
gate prevents narrow-PASS gaming, the sentinel catches the
specific bug classes the team has burned on before.

→ see `05-llm-as-judge-as-testing.md` for the calibration deep walk.

#### Step 3 — pillar 3: the category coverage gate

The gate that prevents "the judge passed but the agent only ran on
2 of 10 categories." Concretely: a count over the agent's output
across the eval run, asserting each anomaly category is seen at
least once.

```ts
// illustrative — the Olist-era harness in mcp-server-olist
// (not in this repo today)
const SEEN: Record<Category, number> = {};
for (const entry of GOLD_SET) {
  const output = await runAgent(entry.input);
  for (const anomaly of output) {
    SEEN[anomaly.category] = (SEEN[anomaly.category] ?? 0) + 1;
  }
}
for (const cat of ALL_CATEGORIES) {
  expect(SEEN[cat], `category ${cat} not surfaced in any gold-set entry`)
    .toBeGreaterThanOrEqual(1);
}
```

Why this matters: an LLM agent under prompt pressure can quietly drop
a category — if the prompt is rewritten to be more concise and an
example category disappears, the agent never surfaces it again, and
the judge's per-criterion score doesn't catch "this category is
absent" because it scores on the entries that ARE there.

The coverage gate is what catches the **silent regression of
omission**. The judge catches the regression of *wrong* output;
coverage catches the regression of *missing* output.

The cousin pattern lives in this repo today — see
`lib/mcp/tool-coverage.ts` and `test/mcp/tool-coverage.test.ts`. That
file checks "every configured tool is exposed by the MCP server"
which is the same shape of gate (coverage as a unit-test concern,
not an LLM-eval concern) — different domain, identical discipline.

#### Step 4 — pillar 4: the BRL currency sentinel (the bug catch)

The pillar that proved the eval pipeline was earning its keep. A
specific gold-set entry: a Brazilian-real revenue calculation where
the expected value was `R$ 1,234.56` and the threshold was
`abs(actual - expected) <= 0.01`.

```
  the BRL bug, reconstructed:

   ┌─ before the eval caught it ──────────────────────────────────┐
   │  lib/insights/derive.ts had:                                   │
   │    Math.floor(revenueImpact * 100) / 100                       │
   │  → BRL amounts ending in odd cents (R$ 12.05) rounded DOWN    │
   │    to R$ 12.04                                                 │
   │  → small per-transaction error, compounded over thousands of  │
   │    transactions, surfaced as a ~$0.50 daily drift             │
   │  → undetectable to a human reviewer reading agent output;     │
   │    only the eval's exact-comparison sentinel caught it         │
   └──────────────────────────────────────────────────────────────┘

   ┌─ after the eval flagged it ──────────────────────────────────┐
   │  the eval run failed at the BRL sentinel                       │
   │  engineer traced: derive.ts used Math.floor, should have       │
   │  used Math.round                                                │
   │  one-line fix, eval re-run, green                              │
   │  → bug never shipped to prod                                   │
   └──────────────────────────────────────────────────────────────┘
```

The sentinel exists because the bug class existed. Sentinels are not
preemptive — they're the eval's memory of "we burned on this
before; we will not burn on it again."

This is the **single concrete artifact** that makes the eval
pipeline's interview story land. "The pipeline caught a bug" is
specific; "it makes us feel more confident" is hand-waving. The
sentinel is what converts the discipline into a story with a verb.

#### Step 5 — wiring all four into a CI gate

```
  what the flywheel pass looks like in CI (illustrative):

  npm run eval
  ├─ pillar 1: load 30 gold-set entries                          ✓
  ├─ for each entry:
  │   ├─ run agent under test
  │   ├─ pillar 2: judge scores against rubric                   ✓
  │   ├─ pillar 4: if BRL sentinel entry, check exact threshold  ✓
  │   └─ record the agent's anomaly categories
  ├─ pillar 3: assert every category seen ≥ 1×                   ✓
  └─ pillar 2 (aggregate): mean overall score ≥ 3.5,
                            per-criterion median ≥ 3              ✓

  → green: merge allowed
  → red:   merge blocked, engineer reads judge reasoning,
           iterates on the prompt, re-runs
```

The four pillars run inside one `npm run eval` (or a vitest file with
a longer timeout). The result is a single PASS/FAIL the CI gate can
read. The flywheel is the loop of (red → iterate → re-run); the gate
is what makes the loop happen at all.

#### Step 6 — what Case B means in practice today

```
  reality check: state today vs Olist era

  asset                   Olist era (until PR #8)     today (Bloomreach)
  ─────────────────────   ───────────────────────     ────────────────────
  gold set                ~30 entries hand-judged     0 entries
                          against Olist data
  judge prompt + rubric   versioned, calibrated       not in repo
  category coverage       sat in eval/coverage.ts     not in repo
   gate                                               (cousin: lib/mcp/
                                                      tool-coverage.ts —
                                                      same shape on a
                                                      different domain)
  BRL sentinel            single gold-set entry +     not in repo
                          exact threshold
  CI integration          npm run eval ran on every   not in repo
                          PR; blocked merge on red
  bug catches             ≥1 documented (BRL          0 (no harness)
                          rounding); the proof
                          the pipeline earned its
                          keep
```

The pattern is on the résumé. The implementation lives in git history
of a sibling repo (`mcp-server-olist`). The current `blooming_insights`
repo has 0 of the 4 pillars wired up. That's the honest line.

### Move 2 variant — the load-bearing skeleton

The kernel of the four-pillar pattern is the **four pillars in
combination**. Any one alone is a partial signal; the four together
become a flywheel. What breaks with each missing:

```
  THE KERNEL — four parts, what breaks if missing

  1. GOLD DATASET
     hand-judged (input, expected, human_verdict) entries
     → without it, the judge has nothing to calibrate against and
       the harness has nothing to run on; you can't tell if a
       prompt change broke anything because there's no reference

  2. LLM-AS-JUDGE
     calibrated by K manual spot-checks; structured verdict
     → without it, the gold set has no oracle to score against
       at scale; every eval run requires human review (doesn't
       scale past 10 entries)

  3. CATEGORY COVERAGE GATE
     count per category, assert ≥ 1 per run
     → without it, the judge can pass a narrow subset of categories
       while the prompt silently drops one; regression of omission
       goes undetected

  4. BUG-CLASS SENTINELS (the BRL kind)
     specific gold-set entries with hand-tuned exact thresholds
     → without it, known bug classes can recur silently because the
       judge's tolerance was wider than the bug's symptom

  ALL FOUR have to be wired into CI gates. Without CI integration
  the flywheel doesn't spin — the eval becomes "something a person
  occasionally runs" and the prompt iteration loop dies.
```

The skeleton's irreducible part: **the loop**. Eval result → human
iterates → eval re-runs. If the eval is run-once-then-forgotten, the
pattern collapses into "we ran some tests once." The flywheel is what
turns the four pillars from a checklist into a process.

The interview-payoff move is naming **the BRL sentinel** as the
moment the eval pipeline justified itself. "We built a harness, the
harness caught a real bug before it shipped, the harness was worth
its build-time." That's the story with a verb. Without a concrete bug
catch, the pipeline narrative reduces to "we had good intentions" —
which is exactly what interview rounds discount.

### Move 3 — the principle

**An eval is a test that gates a prompt change the same way unit
tests gate a code change.** The four pillars turn "we look at the
agent's output sometimes" into "no prompt change ships without
clearing these four checks." Once the pipeline is in CI, the
prompt becomes versioned-by-merit rather than versioned-by-vibes.

The deeper principle for AI-engineering work: **the pipeline IS the
team's understanding of what good means**. Every gold-set entry is a
codified product decision. Every sentinel is a codified bug memory.
Every rubric criterion is a codified quality dimension. The pipeline
isn't infrastructure — it's the team's accumulated judgment, made
executable.

Which is also why the **retirement** part of the story matters. When
the substrate changes, the team's understanding (encoded in the
pillars) becomes stale. Carrying a stale eval forward as if it still
applies is worse than retiring it deliberately and rebuilding when
the new substrate is stable. The discipline includes knowing when to
sunset.

## Primary diagram — the four pillars + the flywheel, one frame

```
  THE EVAL FLYWHEEL — one frame (RETIRED with PR #8 / 2026-06-18)

  ┌─ ONE EVAL RUN ─────────────────────────────────────────────────┐
  │                                                                  │
  │   GOLD SET (pillar 1)            JUDGE (pillar 2)                │
  │   ┌──────────────────┐           ┌──────────────────────┐        │
  │   │ ~30 entries:     │ ──────────►│ rubric prompt,       │        │
  │   │ (input, expected,│  per entry │ calibrated against   │        │
  │   │  human_verdict)  │            │ gold set by K=10     │        │
  │   └──────────────────┘            │ spot-checks          │        │
  │            │                       └──────────┬───────────┘        │
  │            │                                  │  verdict           │
  │            ▼                                  ▼                    │
  │   run agent → output                  { scores, overall,           │
  │   (probabilistic)                       reasoning }                │
  │            │                                  │                    │
  │            └──────────────┬───────────────────┘                    │
  │                           │                                        │
  │   COVERAGE GATE (pillar 3)│  BRL SENTINEL (pillar 4)               │
  │   ┌──────────────┐        │  ┌─────────────────────┐               │
  │   │ every        │ ◄──────┼─►│ specific gold entry,│               │
  │   │ category     │        │  │ exact threshold     │               │
  │   │ seen ≥ 1×    │        │  │ on revenue ±$0.01   │               │
  │   └──────┬───────┘        │  └──────────┬──────────┘               │
  │          │                │             │                          │
  │          └────────┬───────┴─────────────┘                          │
  │                   ▼                                                │
  │              PASS / FAIL → CI gate                                 │
  └─────────────────────────────────────┬──────────────────────────────┘
                                        │
                          ┌─────────────┴──────────────┐
                          │                            │
                          ▼                            ▼
                  GREEN → ship                   RED → block merge
                                                    │
                                                    │  human reads
                                                    │  judge reasoning
                                                    ▼
                                              prompt v_{N+1}
                                                    │
                                                    │  re-run
                                                    │
                                              ┌─────┘
                                              │
                                              ▼
                                       new gold-set entry
                                       added if it's a new
                                       regression class
                                              │
                                              └──► back to top
                                                   THE FLYWHEEL
```

## Elaborate

The four-pillar pattern isn't novel — it's the eval discipline that
emerged across LLM teams ~2023-2024 as production-grade RAG and
agent systems shipped. Pieces of it appear in OpenAI's evals library,
Anthropic's eval cookbooks, the LangSmith / LangChain eval surface,
and most major AI infra vendors. What's notable about the framing
here is that **all four pillars are required** — many teams ship one
or two (gold set + judge, or coverage gate alone) and discover the
gaps when the unobserved class of regression hits prod.

What makes this specifically a *flywheel*: the gold set GROWS. Each
regression caught becomes a new entry. Over six months, the gold set
encodes the team's full memory of "ways the agent has been wrong
before." That accumulation is what makes the eval get sharper over
time rather than degrading — and it's also what makes it expensive
to abandon (every retired gold-set entry is a lesson the team has to
re-learn).

The retirement decision (PR #8) was the right call for a specific
reason: when the data substrate (Olist) was replaced with a different
data substrate (Bloomreach), the gold-set entries became irrelevant.
A Bloomreach anomaly has different metrics, different categories,
different evidence shapes. Mechanically translating the Olist gold
set to Bloomreach would produce gibberish — the entries had to be
rebuilt from scratch against the new substrate.

The honest tradeoff: carrying the retired pipeline forward as a
ghost (the `eval/` directory present-but-empty, the CI hook
present-but-skip) costs maintenance attention for zero signal. The
clean retirement (delete it; document the pattern in this study;
plan the rebuild) is what keeps the codebase honest about its
current state.

What would change a rebuild-priority decision today:

  → if a real regression ships in production that an eval would
    have caught — the pipeline jumps to top of the queue
  → if the agent prompts start getting iterated weekly — the lack
    of a regression gate becomes a daily cost
  → if a second engineer joins the project — the value of a
    shared "what good looks like" artifact compounds

Today none of those triggers fire. Rebuild stays on the queue but
not at the top. That's a deliberate priority call, not an oversight.

## Interview defense

**Q: "Walk me through your most production-relevant testing system."**

The four-pillar eval pipeline I shipped against the Olist substrate.
Pillar 1: a ~30-entry gold set, hand-judged. Pillar 2: an LLM-as-judge
with a 5-criterion rubric, calibrated against the gold set by K=10
human spot-checks. Pillar 3: a category coverage gate that asserted
each anomaly category was seen at least once per eval run — the
defense against silent regression-of-omission. Pillar 4: a BRL
currency sentinel that caught a real `Math.floor` vs `Math.round`
rounding bug in revenue calculations before it merged. The flywheel
was: red eval → engineer reads judge reasoning → prompt iteration →
re-run, and new regression classes became new gold-set entries.

The bug catch is what made the pipeline earn its keep. Without that
concrete catch the story is "we built infra and hoped it helped."
With it, the story is "the eval blocked a bug from shipping and we
fixed it in 20 minutes instead of debugging it in prod."

The pipeline retired with PR #8 on 2026-06-18 when we removed the
Olist data substrate. Rebuilding it on the Bloomreach substrate
would mean a fresh gold set against the new data shape — a known
~3-day move I haven't prioritized yet because the current repo's
prompt-iteration cadence is low.

*anchor:* this file's Move 2 walks each pillar; `audit.md` lens 6
names today's gap honestly; `05-llm-as-judge-as-testing.md` for the
judge-calibration sub-pattern.

**Q: "What's the load-bearing pillar?"**

The bug-class sentinels (pillar 4). The other three pillars build the
infrastructure — gold set is the inputs, judge is the scorer, coverage
is the breadth gate. What converts the infrastructure into a thing
that earns its build-time is the moment a sentinel catches a real
bug before merge. Without a concrete catch, the eval pipeline is a
maintenance burden waiting to be cut; with one, it's a paid-for
investment.

I'd name BRL specifically as the catch. Math.floor where Math.round
was correct, on Brazilian revenue calculations, surfaced by an exact
sentinel threshold of ±$0.01. The bug would have been invisible to
human review (rounding to the wrong direction on odd cents) but
deterministically caught by the sentinel.

*anchor:* this file's Move 2 / Step 4 — the BRL sentinel reconstruction.

**Q: "Why isn't this in the repo today?"**

PR #8 on 2026-06-18 removed the `mcp-server-olist` substrate. The
gold set was anchored to Olist's e-commerce data shape; the
sentinel was anchored to Olist's BRL revenue calculations; the
category list was Olist-specific. None of it translates mechanically
to Bloomreach data — the metrics are different (purchase_revenue,
session_start, EQL queries), the categories are different (90-day
windows, country segments), the bug surface is different.

Rebuilding against Bloomreach is a deliberate ~3-day move:
fresh gold set built against the synthetic Bloomreach workspace
(`lib/data-source/synthetic-data-source.ts` would be the deterministic
substrate — same role the Olist fixtures used to play), fresh
rubric tied to Bloomreach output shape, fresh calibration. I
haven't prioritized it because the current repo's prompt-iteration
cadence is monthly, not weekly — the eval's value compounds with
iteration frequency, and the math doesn't currently justify the
rebuild cost.

If I shipped a Bloomreach gold set tomorrow, I'd start with 10
entries (3 obvious-anomaly + 3 subtle + 2 no-anomaly + 2
segment-specific) and add categories as regressions appeared. The
BRL sentinel doesn't carry over — I'd wait for the next concrete
bug-class before adding the first Bloomreach sentinel.

*anchor:* `00-overview.md` "what 'shipped + used + retired' means"
section for the same framing at the overview level; `audit.md` lens 6
for the audit-level honest "not exercised today."

**Q: "How would you rebuild this on the current codebase?"**

Four-step rebuild against the current substrate, in dependency order:

```
  1. gold set (1 day): 10-15 entries against the SyntheticDataSource
     (lib/data-source/synthetic-data-source.ts), hand-judged against
     real MonitoringAgent + DiagnosticAgent + RecommendationAgent runs

  2. judge (1 day): rubric prompt with 5 criteria specific to
     Bloomreach output (anomaly correctness, severity calibration,
     scope specificity, evidence grounding, business impact);
     calibrate by K=10 spot-checks

  3. coverage gate (½ day): count per anomaly category over the gold
     set run; assert ≥ 1× per category. Already have the cousin
     pattern in lib/mcp/tool-coverage.ts — copy the shape.

  4. CI integration (½ day): new vitest file at test/eval/agents.eval.test.ts
     with a longer timeout, or a separate npm run eval command;
     wire into the GitHub Actions workflow as a required check
```

Sentinels (pillar 4) come later, when a real bug surfaces. They're
reactive, not preemptive.

*anchor:* this file's Move 2 walks each pillar; the rebuild plan
maps each pillar to a real file in the current codebase that would
either be created (`test/eval/`) or copied-from (`lib/mcp/tool-coverage.ts`).

## See also

  → `05-llm-as-judge-as-testing.md` — pillar 2 deep walk; same Case
    B framing.
  → `04-acceptance-with-per-gate-rejection.md` — the per-gate
    discipline pillar 2's rubric inherits when scoring multiple
    criteria.
  → `audit.md` lens 6 — the audit-level honest "not exercised
    today" plus the shipped-and-retired note.
  → `00-overview.md` — the determinism-vs-evaluation seam diagram
    that explains why this concept belongs in the testing study at
    all.
  → `study-ai-engineering` — where the *probabilistic-output*
    evaluation lives long-term. This guide covers only the
    deterministic-harness-around-the-eval framing.
