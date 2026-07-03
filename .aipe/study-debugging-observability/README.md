# Study — Debugging & Observability (applied)

The debugging + observability guide for **blooming insights** — a multi-agent
Next.js app whose observability surfaces are almost all *evidence on disk*
(receipts + baselines) rather than live logs, and whose in-flight signal is
one NDJSON discriminated-union stream shared between the browser and the
evals.

The reader question: **when an investigation goes wrong, what evidence exists
to explain why, and how fast can you get to it?** Everything below answers that
in the shape the repo actually exercises today.

## Reading order

1. **`00-overview.md`** — the observability map in one diagram. Three
   surfaces (NDJSON wire · vitest console · dev cache files) plus the two
   receipt classes (per-case, load-run). Skim this and you have the whole
   evidence pile.
2. **`audit.md`** — Pass 1, the 8-lens audit. Each lens grounded in
   `file:line`; lenses the repo doesn't yet exercise are named honestly.
3. **Pattern files, in order:**
   1. `01-ndjson-agent-event-wire.md` — the 8-variant discriminated-union
      event stream that carries every diagnostic signal on the live path;
      one producer, four consumers.
   2. `02-receipts-as-evidence.md` — per-case receipts on disk as the
      canonical evidence pile; how latency/token/cost math is computed
      offline; why receipts exist at all.
   3. `03-per-phase-timing-log.md` — the one summary line every route
      handler emits on the way out (even on error), shared shape between
      `/api/agent` and `/api/briefing`; the 300s-budget incident signal.
   4. `04-capability-trace-fanout.md` — the `onCapabilityEvent` hook that
      captures raw AptKit trace events at the seam; feeds `summarizeUsage`
      and `estimateCost` without touching Anthropic's API.
   5. `05-budget-tracker-as-guard.md` — the per-investigation ceiling that
      halts a runaway loop before it burns more cost; how the graceful
      NDJSON `error` event exposes the breach.
   6. `06-log-redaction-and-error-chain.md` — the token-redaction pass +
      `cause`-chain walker that keeps Bearer tokens out of Vercel logs
      while preserving the real server error text.
   7. `07-regression-gate-and-baseline.md` — how the committed baseline +
      candidate gate turn "did the last change regress the agent" from
      opinion into a numeric verdict.

## Cross-links to neighboring guides

- `study-testing` — catches known failure conditions *before* release
  (the 261 unit tests + the goldens + judge rubrics as gating). This guide
  covers what happens when something surprises the tests and you need
  evidence to explain it.
- `study-performance-engineering` — measures the p50/p95/p99 that these
  same receipts populate; teaches what to *do* about a slow phase. This
  guide teaches how the phase becomes visible in the first place.

The partition seam: **testing catches known failures, this guide explains
unknown behavior, performance decides what to optimize.** A finding belongs
to the generator that owns the mechanism. Cross-linked, not restated.
