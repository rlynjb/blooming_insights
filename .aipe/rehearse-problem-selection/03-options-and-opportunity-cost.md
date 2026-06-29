# 03 — Options and Opportunity Cost

> The options that were on the table — including `do nothing` — and what each one would have cost in time, complexity, and product surface.

```
  THE OPTION SPACE — six paths, one chosen

  ┌────────────────────────────────────────────────────────────────┐
  │                                                                │
  │   A. do nothing            │  ← always on the table            │
  │   ─────────────────────    │                                   │
  │   B. dashboard tool        │  build into Bloomreach UI         │
  │   C. single-agent answerer │  one big agent, one big prompt    │
  │   D. multi-agent loop      │  ← chose this                     │
  │      + reasoning trace UI                                      │
  │   E. native Bloomreach     │  ship as a Bloomreach feature     │
  │   F. ecommerce-platform-   │  generalize to Shopify / etc      │
  │      agnostic agent                                            │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘

  the chosen option is the one that defends its own scope cuts.
```

## The opportunity-cost discipline

For each option below: **what we build, what we give up, and what the "1-week sniff-test" tells us** — the smallest experiment that would either kill the option or harden it before going further. **The chosen option has to beat `do nothing` on a real axis, not a hand-wave.**

---

## Option A — Do nothing

**What it means:** the analyst keeps doing the three-context loop by hand. We don't ship anything.

**Why it's the baseline:** if `do nothing` wins, no other option matters. Every option below has to defend itself against the cost of building it vs the cost of the analyst's current workflow.

**What `do nothing` actually costs:**
- The analyst keeps context-switching across three tools. That's the status quo — by definition not a regression.
- Recommendations continue to lack visible reasoning. Stakeholders continue to either trust the analyst or not.
- The MCP server matures without us using it. The agent capability we have available right now goes unused.

**Why we don't pick it:** two reasons, one product, one personal:
1. **Product:** the reasoning-trace bet is testable. If "show your work" beats "magic answer," we want to know — and `do nothing` doesn't generate that signal.
2. **Personal (named honestly — this matters in an L5 review):** the project is an AI-engineering portfolio piece for a frontend engineer pivoting into AI roles. **`do nothing` produces no artifact to defend in an interview loop.** That's a real opportunity cost — naming it is the move.

**The honest framing:** `do nothing` is a defensible option for the marketer. It's not defensible for the engineer building the portfolio.

---

## Option B — Build it as a Bloomreach dashboard tool

**What it means:** instead of a separate Next.js app with agents, build it as a dashboard inside Bloomreach Engagement. The analyst stays in one tool.

**Why it's tempting:** zero context-switching cost. The product is just "a smarter view inside Bloomreach."

**What we'd give up:**
- **The reasoning-trace surface.** A dashboard tile is not a 1/3-width streaming sidebar. Reasoning becomes a "click to expand" tooltip — defeating the bet.
- **Iteration speed.** Building inside someone else's product means their release cycle, their UI primitives, their auth. We can't ship in a week.
- **The portability story.** A Bloomreach-internal tool dies if we ever want to be ecommerce-platform-agnostic (see Option F).
- **Control of the agent loop.** A Bloomreach tile probably can't run a Claude agent with arbitrary tool calls and a `maxToolCalls` budget. The architecture flattens to "send the query, render the answer."

**The 1-week sniff-test:** ask Bloomreach if a Bloomreach customer can run a Claude agent that streams reasoning inside their UI. If the answer is "we'd have to build that infra," the option is dead.

**Why we don't pick it:** the reasoning trace is the differentiator, and a dashboard tile can't host it as a first-class surface. The bet collapses.

---

## Option C — Single-agent answerer (one big agent, one big prompt)

**What it means:** one agent. One system prompt. Ask "what's wrong with my workspace?" and let the model do everything — anomaly detection, diagnosis, recommendation — in one long turn.

**Why it's tempting:** simpler code. No coordinator. No handoff between agents. The model "just figures it out."

**What we'd give up:**
- **Predictable structure.** A multi-agent split with `AgentName = coordinator|monitoring|diagnostic|recommendation` (in `lib/mcp/types.ts`) gives every step a known shape — known inputs, known outputs, known evaluation criteria. A single-agent answerer is unpredictable; you don't know which step it's on, so the UI can't render a stepper that means anything.
- **The stepper UI itself.** The shared `ProcessStepper` (monitoring → investigating → decision) **only makes sense if there are discrete stages.** A single-agent answerer collapses the stepper into a single spinner.
- **Independent evaluation.** With separate agents, each one can be evaluated against its own rubric (detection precision/recall, diagnosis criteria, recommendation criteria). With one agent doing everything, you only get end-to-end pass/fail — much weaker signal.
- **Cost control.** Separate agents = separate token budgets. The monitoring agent doesn't need a 200K-token context window; the diagnostic one might. Mixing them wastes tokens.

**The 1-week sniff-test:** prompt-engineer a single agent that does monitoring + diagnosis + recommendation in one turn. Time how long it takes to produce one anomaly's worth of work. If the latency is acceptable and the structure is consistent, the option is alive. **It is neither, in practice — the loop diverges, the structure is mush, and the trace is unparseable.**

**Why we don't pick it:** the single-agent shape can't support the stepper UI, can't support per-step evaluation, and can't sustain the reasoning-trace surface as a coherent narrative. The structure isn't a code-cleanliness preference; **it's what makes the product visible.**

---

## Option D — Multi-agent loop + reasoning trace UI (CHOSEN)

**What it means:** a coordinator + three specialist agents (monitoring, diagnostic, recommendation), each with its own prompt and tool set. The reasoning trace is streamed as NDJSON and rendered as a first-class UI surface on every page.

**What we get:**
- **The stepper UI maps 1:1 to the agent split.** Monitoring → investigating → decision matches the agent identities. The user's mental model and the code's structure are the same model.
- **Per-step evaluation is possible.** Each agent can be evaluated against its own rubric (detection precision/recall, diagnosis criteria, recommendation criteria). The 4-pillar eval suite that surfaced the BRL bug, the calibration drift, and the conclusion instability **was only possible because the agents are separately addressable.**
- **The reasoning trace is structured.** Each `AgentEvent` carries the agent identity, the step kind, the tool calls, and the timestamps — so the trace renders as "the monitoring agent called `execute_analytics_eql` with this EQL and got this result" rather than "the AI did some stuff."
- **Independent iteration.** The recommendation agent's prompt can be rewritten without re-validating monitoring or diagnosis. That's a real velocity win when the product is being tuned weekly.

**What we give up:**
- **Code complexity.** Four agents, a coordinator, the NDJSON event protocol, the streaming UI plumbing — more code than Option C. This is the deliberate cost.
- **Latency overhead.** Each agent handoff is a model call, plus serialization through the event stream. Acceptable for the analyst persona (their alternative is a 15-minute manual loop), unacceptable for an "instant answer" persona — and that persona is not the user.
- **A migration we had to make.** Phase 1 used a hand-rolled `runAgentLoop` (deliberate at the time — needed `maxToolCalls` budget + forced synthesis turn against the rate-limited server, `lib/agents/base-legacy.ts` preserves it). Phase 4 migrated to `@aptkit/core@0.3.0` via 3 adapter classes in `lib/agents/aptkit-adapters.ts`. **Library owns the loop, I own the boundary, legacy preserved as a rollback receipt.** That's an `evaluated-and-accepted` move — revisiting a decision that was originally defended deliberately, once the better surface existed.

**Why we picked it:** it's the only option that supports the reasoning-trace surface as a first-class product surface, the only one where the stepper UI maps to a real architecture, and the only one where per-agent evaluation is even possible. The cost is justified.

---

## Option E — Ship as a native Bloomreach feature (vs an independent app)

**What it means:** partner with Bloomreach and ship this as part of Bloomreach Engagement — not as a separate webapp. Effectively a more ambitious version of Option B.

**Why it's tempting:** every Bloomreach customer gets it. Distribution is solved. We don't have to acquire users.

**What we'd give up:**
- **Iteration speed and product control.** Bloomreach's release cycle, brand constraints, support obligations, security review for every change.
- **The ability to ship a v0 in weeks.** A native feature has to land at v1.0 quality from day one — there's no "ship the loop first, evaluate against a stable substrate later" path.
- **The portfolio story.** A feature inside someone else's product is harder to point at in an interview than an app you can demo end-to-end.

**The 1-week sniff-test:** none, really — this is a business-development question, not a technical one. The answer is "we don't have a Bloomreach partnership and acquiring one takes months."

**Why we don't pick it (now):** distribution-via-Bloomreach is a real win, but it's a separate decision from "is this product worth building." Build it independently first, then have the partnership conversation with a working demo in hand. **Sequencing matters — picking it now means waiting on someone else's calendar.**

---

## Option F — Ecommerce-platform-agnostic agent (Shopify / WooCommerce / Bloomreach)

**What it means:** abstract the analytics platform behind a `DataSource` port; the agents work against any backing platform. Ship for Bloomreach, Shopify, WooCommerce, BigCommerce.

**Why it's tempting:** larger market. The reasoning-trace value prop is platform-agnostic.

**What we'd give up:**
- **Time-to-validate.** Building three or four adapters means we don't have a working v0 against any one platform. The product becomes "an integration project" before it becomes "an analyst's reasoning loop."
- **The depth of the Bloomreach integration.** Bloomreach has scenarios, segments, vouchers, experiments — a specific recommendation vocabulary. Shopify has Flow, customer segments, Shopify Email. Generalizing the recommendation agent means it can only suggest the lowest-common-denominator action — losing the "name the exact Bloomreach feature" precision that's currently a strength.
- **A reasoning-trace surface that has to work the same across platforms.** That's a substantive product-design problem we haven't solved.

**The 1-week sniff-test:** would a Shopify analyst pay for an AI loop that proposes "create a Shopify Flow trigger" with full reasoning? Probably yes. But the sniff-test for **the integration cost being acceptable** is much longer than one week.

**Why we don't pick it (now):** Bloomreach-specific is the right scope for v0 because **the recommendation vocabulary is the load-bearing detail.** Generalizing too early means the recommendations get vaguer. **The `DataSource` seam (the port + the in-process Synthetic adapter that lives behind it) keeps the option open** — if we want to add a second platform later, the seam is built. But we're not adding it now.

---

## The chosen option, said sharply

**Option D — multi-agent loop + reasoning-trace UI as a first-class surface, Bloomreach-specific, read-only, no persistence, demo-snapshot for reliable presentation.**

The opportunity cost we accepted: code complexity (more agents, more plumbing) and platform specificity (we're not generalizing yet). Both costs are bounded and named. **Every other option either collapses the differentiator (B, C, E) or delays time-to-validate to the point where we can't generate signal (F) or generates no signal at all (A).**

The defensible posture in a review is: "I considered each of these, named what I gave up, named the 1-week sniff-test, picked D. Here's the receipt — every cut in `02-scope-cuts-and-non-goals.md` is a deliberate consequence of picking D, not an accident."
