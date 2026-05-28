# blooming insights — user guide

## what is blooming insights?

blooming insights is an AI analyst for your Bloomreach Engagement workspace. Instead of digging through dashboards, you open it and it tells you **what changed, why it happened, and what to do about it** — and it shows its work the whole way, so you can see exactly how it reached each conclusion. It's built for ecommerce teams who want answers, not more charts.

---

## getting started

1. **Open blooming insights.** You land on the feed, headed **blooming insights** with the line *"your workspace, in bloom."*
2. **Connect your Bloomreach workspace (first time only).** If the app isn't connected yet, it sends you to Bloomreach to sign in and approve access, then brings you back. You only do this once per session.
3. **Wait a few seconds while it works.** You'll see *"agents analyzing the workspace…"* with placeholder cards. The analyst is scanning your workspace for notable changes.
4. **Read your briefing.** The feed fills with insight cards — the most significant changes, most urgent first. That's your starting point.

> **Good to know:** blooming insights is **read-only**. It never changes anything in your Bloomreach workspace — it only reads, analyzes, and suggests. If you're viewing a demo build, the feed and its investigations are pre-loaded, so everything works instantly without connecting an account.

---

## features

### the feed (your morning briefing)

*What it does* — Shows the most notable recent changes in your workspace as a stack of insight cards, so you see what needs attention the moment you open the app.

*How to use it* — Just open the app; the feed loads on its own. Each card shows:
- a **colored dot** for severity — coral = critical, amber = warning, teal = a positive change, muted = informational;
- a one-line **headline** (e.g. `usa purchase_revenue · -38.4%`);
- a short **summary** of the change;
- **scope tags** (like `global` or `usa`) and a timestamp;
- an **investigate →** prompt.

*What you'll see* — 3–5 insight cards, ordered with the most critical at the top. If nothing significant changed, you'll see *"no notable changes right now."*

*Good to know* — The cards are a summary. To get the *why* and *what to do*, open one (next feature).

---

### investigating an insight

*What it does* — Opens a deep-dive that diagnoses **why** an insight happened and recommends **what to do** — while streaming the agents' reasoning live, so nothing is a black box.

*How to use it*
1. On the feed, **click any insight card** (or its **investigate →** prompt).
2. Watch the investigation build itself in real time. You don't need to do anything — it runs on open.
3. To go back, click **← feed** in the top-left.

*What you'll see* — A three-part view that fills in as the analyst works:
- **A pipeline indicator** in the header — `monitoring → diagnostic → recommendation` — that lights up the stage currently working, next to a live status that reads *analyzing…* and then *complete*.
- **A reasoning trace** (left) — the diagnostic agent's thoughts and each data query it runs, appearing one by one. Click any tool step to expand its raw result and see how long it took.
- **A diagnosis** (right) — a plain-language conclusion, a list of **evidence** behind it, and a collapsible **hypotheses considered** section showing what the agent tested and ruled out (click to expand). If a customer group was affected, you'll see the count and a description.
- **Recommendations** (right, below the diagnosis) — 2–3 concrete actions, each tagged with the Bloomreach feature it uses (scenario, segment, campaign, voucher, or experiment), a confidence level, a short rationale, numbered setup steps, and an **impact:** estimate.

*Good to know* — A fresh, live investigation takes a little time, because the analyst runs real queries against your workspace as you watch. Recommendations are **suggestions for you to act on** — the app doesn't carry them out.

---

### exporting an investigation

*What it does* — Saves the full investigation — reasoning trace, diagnosis, and recommendations — as a Markdown file you can share or keep.

*How to use it* — Once an investigation finishes (or a diagnosis has appeared), click **export ↓** in the investigation header. Your browser downloads a `.md` file.

*What you'll see* — A downloaded Markdown document with the reasoning trace, the diagnosis (conclusion, evidence, hypotheses), and every recommendation with its steps and impact.

*Good to know* — The **export ↓** button only appears once there's something to export.

---

### asking your own question

*What it does* — Lets you ask a free-form question about your workspace in plain English and get a grounded answer, with the analyst's reasoning shown.

*How to use it*
1. In the **ask anything about your workspace…** box fixed at the bottom of the feed, type a question — e.g. *"which countries had the most purchase revenue?"*
2. Press **Enter** or click **ask**.
3. The answer streams in, pinned at the top of the feed. Click **× clear** to dismiss it.

*What you'll see* — The analyst interprets your question, runs the queries it needs, and gives a concise answer citing the real numbers it found. A **show reasoning** toggle reveals the steps and queries behind the answer.

*Good to know* — Questions are answered **live**, so this needs an active workspace connection (it isn't available in the pre-loaded demo build). Answers reflect the data the analyst could find; if data is thin for a time period, it will say so rather than guess.

---

## tips & common questions

**Can it change anything in my Bloomreach account?**
No. blooming insights is read-only — it reads and analyzes your data and *suggests* actions, but never edits, sends, or runs anything in your workspace.

**Where does my data go? Is anything saved?**
Your insights and investigations live in your session as you use the app; nothing is written back to Bloomreach. There's no separate account or database to manage.

**How do I get back to the feed from an investigation?**
Click **← feed** in the top-left of the investigation view.

**Why does an investigation (or a question) take a moment?**
The analyst runs real queries against your workspace and reasons over the results in real time — that's the part you watch stream in. Insights you've opened before come back quickly.

**What do the colored dots mean?**
Severity: coral = critical, amber = warning, teal = a positive change, muted/grey = informational. On a recommendation, the dot shows confidence (teal = high, amber = medium, grey = low).

**What if the feed says "no notable changes right now"?**
That's the honest result — the analyst scanned the workspace and didn't find a change significant enough to flag. It won't manufacture an alert.

**A recommendation looks good — how do I do it?**
Follow the numbered **steps** on the recommendation card in your Bloomreach Engagement workspace. The card names the exact feature to use (e.g. a scenario or a segment).

---

## coming soon

- **One-click apply** — turning a recommendation into a live Bloomreach action (e.g. launching the suggested campaign) directly from the card. For now, recommendations are step-by-step suggestions you carry out yourself in Bloomreach.
