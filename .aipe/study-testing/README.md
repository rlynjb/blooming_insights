# Testing & correctness — applied to this repo

How do you know it works, and how do you know it'll keep working after
the next change? That's the question this folder answers — against
this exact codebase, not in the abstract.

## Where this sits — the AI-eval seam

There are two halves of "is the output correct," and they pull apart
cleanly:

```
  the seam — deterministic correctness vs probabilistic evaluation

  ┌─ DETERMINISTIC ──────────────┐  ┌─ PROBABILISTIC ─────────────────┐
  │  given input X, assert it    │  │  given a non-deterministic      │
  │  produced output Y           │  │  output, is it good enough /    │
  │                              │  │  did it regress?                │
  │  this folder ▲               │  │  study-ai-engineering ▼         │
  │  → 24 vitest files           │  │  → built once, retired (PR #8)  │
  │  → 221 unit + integration    │  │  → next-version target lives    │
  │    tests                     │  │    on the synthetic substrate   │
  └──────────────────────────────┘  └─────────────────────────────────┘
```

If the assertion is `expect(parsed.severity).toBe('critical')`, that's
testing — it lives here. If the assertion is "the LLM's prose answer
hits the same conclusion 8/8 runs," that's evaluation — it lives in
`study-ai-engineering`. They meet when you test an AI feature: the
deterministic harness wrapping a probabilistic core. The pattern this
repo nails is *injected fakes* — every test in `test/agents/` runs the
real `runAgentLoop` against a scripted fake of the SDK type
(`Anthropic.Messages.Message`), so the assertions are deterministic
against a probabilistic system.

A note on the eval half: this repo built one (a 4-pillar suite on the
Olist substrate during Phase 3), calibrated an LLM-as-judge against
manual spot-checks, and surfaced three real bugs from it (a BRL
cents-vs-Reais run, a 29/30 binary-calibration drift, a 30%
conclusion-instability rate). PR #8 retired the substrate and the
suite with it. The next-version target rides the synthetic data
source — that's `study-ai-engineering`'s problem, not this folder's.

## What lives here

```
  .aipe/study-testing/
    README.md                              ← you are here
    audit.md                               ← Pass 1: 7-lens audit
    01-injected-fake-anthropic-client.md   ← Pass 2: discovered patterns
    02-mcp-as-callable-port.md
    03-type-guard-as-runtime-validator.md
    04-real-fixture-snapshot-test.md
    05-tracked-env-stubbing.md
    06-scripted-ndjson-integration-harness.md
```

## Reading order

  1. `audit.md` first — the 7-lens audit pins what's tested, what
     isn't, where the smells are, and which lens findings cross-link
     to a pattern file.
  2. Pattern files in numbered order — each one names a testing
     technique the repo applies deliberately, walks the kernel, and
     answers *"what would the suite stop catching if I stripped it
     out?"*

## The headline

  → 24 test files, 221 tests, all passing, ~6.2s wall clock.
  → Strong unit + integration coverage on the agent loop, the MCP
    seam, validators, the streaming kernel.
  → Zero React / hook tests. The whole UI layer (~19 components,
    4 hooks, 3 page routes) has no automated coverage.
  → The eval half is a built-and-retired arc — Case B in the family
    framing. Synthetic-substrate v2 is the next-version target.
