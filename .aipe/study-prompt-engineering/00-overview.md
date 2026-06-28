# Overview — prompt engineering in `blooming_insights`

The orientation page. Where prompts live, who calls them, what they produce, and where every later concept file plugs in.

## The system, one diagram

```
  Where prompts live, top to bottom

  ┌─ UI (React 19 · App Router) ─────────────────────────────────────────────┐
  │  feed page · investigate pages · QueryBox                                │
  └──────────────────────────────────┬───────────────────────────────────────┘
                                     │  fetch + NDJSON ReadableStream
  ┌─ Route handlers (/api/briefing · /api/agent) ───────────────────────────┐
  │  bootstrap MCP schema  →  instantiate agent  →  stream events back      │
  └──────────────────────────────────┬───────────────────────────────────────┘
                                     │
  ┌─ Agent adapters (lib/agents/*.ts) ──────────────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent · QueryAgent    │
  │  intent.classifyIntent                                                   │
  │  Each one a thin wrapper that:                                           │
  │    • picks the right AptKit agent class                                  │
  │    • passes 3 adapters (model · tools · trace) + workspace schema        │
  └──────────────────────────────────┬───────────────────────────────────────┘
                                     │
  ┌─ AptKit runtime (@aptkit/core@0.3.0) ───────────────────────────────────┐
  │  AnomalyMonitoringAgent · DiagnosticInvestigationAgent · ...             │
  │  Owns: the tool-use loop · forced-final synthesis turn · validators      │
  │  Carries the active system prompts (Bloomreach-only)                      │
  └──────────────────────────────────┬───────────────────────────────────────┘
                                     │
  ┌─ Anthropic API · MCP server ────────────────────────────────────────────┐
  │  claude-sonnet-4-6 (agents) · claude-haiku-4-5 (intent)                  │
  │  Bloomreach loomi connect MCP → execute_analytics_eql + ancillary tools  │
  └──────────────────────────────────────────────────────────────────────────┘

  Legacy prose-source-of-truth (Bloomreach-only) at:
    lib/agents/legacy-prompts/{monitoring,diagnostic,recommendation,query}.md
  Loaded only by lib/agents/*-legacy.ts (not the active path).
```

The active path runs through AptKit; the legacy `.md` files are the version-controlled Bloomreach-only source-of-truth for the same shapes, kept readable as markdown for review and audit.

## The five agents and what each one's prompt does

| Agent          | What its prompt asks for                                            | Output shape                |
|----------------|---------------------------------------------------------------------|-----------------------------|
| `monitoring`   | Walk the category checklist, run 90d-vs-prior-90d, emit anomalies   | `Anomaly[]` (JSON in fence) |
| `diagnostic`   | Generate 2–3 hypotheses, query to falsify, conclude                 | `Diagnosis` (single object) |
| `recommendation`| Given a diagnosis, propose 2–3 Bloomreach actions with dollar impact| `Recommendation[]`         |
| `query`        | Answer a free-form user question with grounded numbers              | Natural-language text       |
| `intent`       | Classify a query as monitoring / diagnostic / recommendation        | One word                    |

Four return structured JSON (a tool-calling agent loop with schema validation at the boundary). One — `query` — returns prose. One — `intent` — is a single-shot classifier with no tools and no JSON. The shape of the output drives almost every prompt-engineering decision downstream.

## The two-axis structure

Two axes carry across every concept file:

```
  axis 1 — output mode             axis 2 — call shape

  structured        ─►  schema     single-shot   ─►  intent
  (JSON / fenced)       validation                   (no tools, 1 turn)
                        boundary
                                   tool-use loop ─►  monitoring · diagnostic
  free prose        ─►  no parse                      · recommendation · query
  (query)               just stream                  (multi-turn, budget-capped,
                        to UI                         forced-final on overflow)
```

Both axes flip the engineering. Structured output forces schemas + validators + retry. Tool-use loops force budget caps + forced-final synthesis. The intent classifier hits neither — it's the simplest possible prompt in the codebase, and the comparison sharpens what makes the others complex.

## What you'll learn, in order

**01–07 — operational discipline.** Read these before the techniques. They are how a prompt becomes production code: four-section anatomy (01), structured outputs via tool-calling (02), prompts-as-code under version control (03), token budgeting (04), eval-driven iteration (05), single-purpose chains (06), output-mode discipline (07).

**08–11 — specific techniques.** Few-shot (08), chain-of-thought (09), self-critique (10), meta-prompting (11). Each one a tool with a sharp shape — knowing when to reach for it is the work.

**12–13 — defense and hygiene.** Prompt-injection defense (12). Forbidden patterns (13).

## What this codebase is honest about NOT having

- **No eval harness in the repo today.** Concept 05 walks the eval-driven iteration pattern and names Case B: the pattern is real, the substrate is absent — no `eval/` directory, no 4-pillar suite, no LLM-as-judge harness in this repo. The honest framing matters — without evals, prompt iteration in this repo is by-hand against the captured demo snapshot.
- **No production prompt-version logging.** The legacy `.md` files are version-controlled, but there's no log entry that says "this output was produced by prompt vX of monitoring.md." Concept 03 names this as the next step.
- **No automated drift detection across model upgrades.** Sonnet 4 → Sonnet 4.6 was a manual swap. Concept 03 names what would need to exist to catch a regression.

These gaps are real, and naming them is part of the discipline. A production AI engineer's portfolio doesn't have to be complete — it has to be honest about what's complete and what's next.
