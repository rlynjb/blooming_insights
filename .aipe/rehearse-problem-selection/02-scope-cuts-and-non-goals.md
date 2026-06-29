# 02 — Scope Cuts and Non-Goals

> What we are deliberately NOT building, and why each cut is load-bearing.

```
  THE FULL PRODUCT SPACE vs WHAT WE'RE BUILDING

  ┌─ what a "complete" analytics product might do ──────────────────┐
  │                                                                 │
  │  detect anomalies  · investigate causes  · recommend actions    │  ← we do this
  │  ────────────────────────────────────────────────────────────   │
  │  schedule scans · persist runs · save/share insights · alerts   │  ← cut
  │  multi-workspace · team workspaces · RBAC · SSO · audit log     │  ← cut
  │  write-back to Bloomreach (one-click apply) · A/B execution     │  ← cut
  │  custom EQL editor · dashboard builder · funnel builder         │  ← cut
  │  drift detection · forecasting · attribution modeling           │  ← cut
  │  Slack/email integrations · workflow automation                 │  ← cut
  │  on-prem / VPC deploy · data residency controls                 │  ← cut
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘

  in scope: the analyst's reasoning loop, made visible.
  out of scope: everything that doesn't make the reasoning sharper.
```

## The cut discipline

A cut is load-bearing when removing it from the cut list would **change which problem we're solving** — not just "make us slower." Each cut below names what's removed, the reason it's removed, and the smallest event that would put it back in scope.

The temptation in a scope-cuts list is to be polite about each cut — "we'll get to it." Don't. **Cuts are deliberate "not this version" calls, and naming them sharply is the move.**

---

## CUT 1 — No persistence (no database, no save/share, no scheduled scans)

**What's removed:** A database. Save-an-insight. Share-via-link. Alerts. Scheduled monitoring. Anything that requires durable cross-session state.

**Why it's cut:** Persistence is a feature wishlist trap. The moment you add a database, you add: schema design, migration discipline, multi-tenant isolation, backup, retention, GDPR, the entire ops surface of a stateful product. **The repo deliberately runs on in-memory maps + gitignored JSON for dev + committed snapshots for demo** — that's a stack decision that says "we are not validating the persistence question yet, we are validating the reasoning-loop question."

**What's in the repo that proves this is deliberate:** `lib/state/insights.ts` and `lib/state/investigations.ts` are explicit in-memory state. The dev fallbacks (`.auth-cache.json`, `.investigation-cache.json` — gitignored) and the committed demo snapshots (`lib/state/demo-insights.json`, `lib/state/demo-investigations.json`) are the substitute. **The product works without a database; adding one would be a deferred decision, not a missing one.**

**The smallest event that puts it back in scope:** an analyst says "I want to come back to last week's investigation and continue it." Two of those in a row and persistence is the next priority. Until then, **`do nothing` on persistence is the right call.**

---

## CUT 2 — No production agent eval beyond manual review

**What's removed:** Production-grade evaluation discipline. A live test bed with N seeded anomalies, K runs per anomaly, calibrated LLM-as-judge metrics, pass/fail thresholds gating deploys.

**Why it's cut:** The phase-1 call was "ship the loop first, evaluate after the substrate is stable." That was deliberate — hackathon scope, against a rate-limited alpha server, with `maxToolCalls` budgets and forced synthesis turns to make the loop terminate. **Building eval against an unstable substrate burns the budget and produces stale numbers.**

**What was learned from doing it once anyway:** A 4-pillar eval suite was built and run — detection precision/recall (K=10 per anomaly), diagnosis 5-criterion rubric, recommendation 3-criterion rubric, regression capture-and-score (structural diff + LLM similarity judge). The LLM-as-judge was calibrated against manual review (8/8 + 3/3 agreement on a spot-check). The suite **surfaced 3 real bugs that no unit test would catch:**

1. **BRL units (cents vs Reais).** The judge flagged an implausible average order value of R$131,965 at run 8 — surfacing that the agent was treating BRL cents as whole Reais.
2. **Binary calibration drift.** A criterion that should have been graded on a 0/1 axis was drifting to 29/30 (too lenient) — invisible without the calibration discipline.
3. **Conclusion instability.** A 30% regression baseline across K=10 runs — a stability problem invisible from any single run.

The suite was **retired with the data substrate it ran against** (the public ecommerce dataset that proved the seam). The rebuild target is named: **the next version runs against the in-process Synthetic adapter**, where the substrate is deterministic and the eval doesn't decay with the data.

**The L5 framing:** the receipt of having built it, calibrated it, found three named bugs with it, and made the deliberate call to retire it with the substrate **is stronger than promising to build it.** A senior reviewer learns more from "I built this, used it to find bugs, retired it for these reasons, here's the rebuild target" than from "we have an eval suite running on every commit."

**The smallest event that puts it back in scope:** the Synthetic substrate stabilizes enough to support deterministic anomaly seeding. That's the rebuild gate — and it's named, not vague.

---

## CUT 3 — No write-back to Bloomreach (no one-click apply)

**What's removed:** The recommendation card has a "launch this campaign" button that writes the scenario / segment / campaign / voucher / experiment back to Bloomreach. The product is read-only.

**Why it's cut:** Write-back changes the trust model. Read-only means "the agent is wrong, you ignore it, no harm done." Write-back means "the agent is wrong, your storefront sends 10K customers a coupon they shouldn't have." **The trust surface we've built — show your work, expandable tool calls, citations on every claim — is calibrated for the read-only case.** Write-back needs a different trust surface: human-in-the-loop confirmation, blast-radius preview, rollback. We haven't built that, and the cut is honest about it.

**What's in the repo that proves this is deliberate:** the MCP tool inventory in `lib/agents/tool-schemas.ts` is read-only. The recommendation agent (`lib/agents/recommendation.ts`) outputs a `Recommendation` with `steps[]` — instructions for the analyst to execute by hand in Bloomreach — not an action it executes itself. The export-to-markdown (`lib/export/investigationMarkdown.ts`) is the handoff artifact; the analyst pastes it into Slack or hands it to ops.

**The smallest event that puts it back in scope:** a marketer says "I trust this enough that the friction of going to Bloomreach and configuring it by hand is now the bottleneck." Until that's a stated complaint, write-back is a solution looking for a problem.

---

## CUT 4 — No multi-tenant, no team workspaces, no RBAC

**What's removed:** Multiple workspaces per user. Multiple users per workspace. Roles. Permissions. Audit log. SSO beyond what the MCP OAuth gives us.

**Why it's cut:** This is one-workspace-per-session. That's enforced in `lib/mcp/auth.ts` — the OAuth client provider is per-user, and the in-memory state in `lib/state/*` is per-process. **Multi-tenant means picking a storage substrate, picking an auth provider, picking a permission model, and rewriting half the agent surface to be tenant-aware.** It's a different product.

**The smallest event that puts it back in scope:** a Bloomreach customer says "I want my team of 4 analysts to collaborate on the same workspace's insights." That's a product-shape change, not a feature add — gated on Cut 1 (persistence) and a real customer asking.

---

## CUT 5 — No custom EQL editor, no dashboard builder

**What's removed:** A surface where the analyst writes their own EQL queries. A way to pin metrics. A way to build saved funnels.

**Why it's cut:** Those tools already exist in Bloomreach. **Rebuilding them inside this product is competing with Bloomreach on the feature surface Bloomreach is best at** — query authoring and dashboard composition. Our product is the **layer above** those tools: the loop that decides what to query, runs it, and explains the answer.

The agent decides which EQL queries to run via the monitoring agent's prompt + the tool schemas. The analyst doesn't write EQL; **they read the agent's reasoning, see which queries it ran, and challenge the queries.** That's a different interaction model than "give me an EQL editor."

**The smallest event that puts it back in scope:** never, in this product. If the analyst needs to write custom EQL, they should be in Bloomreach, not in this app. The seam holds.

---

## CUT 6 — No advanced analytics features (forecasting, attribution, drift)

**What's removed:** Forecasting (will this metric hit the quarter target?). Attribution modeling (which channel drove this?). Drift detection (is my segment definition stale?). Cohort retention curves.

**Why it's cut:** Each of these is its own product. **Forecasting needs a forecasting model — that's not what an LLM agent is.** Attribution needs an attribution methodology choice (first-touch / last-touch / data-driven / Markov). Drift needs baselining infrastructure. **Adding any of them blurs the product's identity from "the analyst's reasoning loop, visible" to "the analytics swiss army knife, also with an LLM."**

**The smallest event that puts it back in scope:** none of these, in this product. They are distinct products. If we want to build one, it's a new app — and that's an L5 call ("I want to make this decision deliberately as a separate product") rather than a feature creep call.

---

## CUT 7 — No Slack/email integrations, no workflow automation

**What's removed:** "Post the anomaly to #marketing in Slack." "Email me a digest every Monday." "Trigger a workflow when X happens."

**Why it's cut:** Notification / integration is a layer that should sit *above* this product — Zapier, n8n, the customer's existing alerting stack. **The product produces structured insights with stable schemas (`Insight`, `Diagnosis`, `Recommendation`, all locked as "what must not change");** anything downstream can consume them. Building the integrations ourselves means maintaining N webhooks instead of one stable API.

**The smallest event that puts it back in scope:** an API surface is asked for. Not a Slack bot. An API. Then customers wire it up their way.

---

## The non-goals as a single sentence

**We are not building an analytics platform. We are building the loop a human analyst runs, made visible, against an existing analytics platform.** Every cut above is a defense of that line.

The reviewer who tries to push any of these back into scope is asking us to **build a different product.** That's a fair conversation to have — but it's a product-strategy conversation, not a feature-scope conversation. Naming it that way is the move.
