# study-testing · blooming insights

**The through-line:** how do you *know* the code works — and will keep
working after the next change? Tests answer the unknown-unknowns
symptom. A suite that doesn't tell you what a change broke before your
users do is decoration.

This audit reads the 26-file, 261-test Vitest suite (+ the offline eval
harness) and asks: **is the design of the test suite sound?** Where's
the risk, where's the design pressure, where's the seam between what's
tested and what's evaluated?

═════════════════════════════════════════════════
THE DETERMINISTIC / EVAL SEAM — read this first
═════════════════════════════════════════════════

Two suites, one repo. They MUST NOT be confused.

```
  Two suites, one determinism seam

  ┌─ npm test  (test/) ─────────────────────────┐
  │  DETERMINISTIC — "equals expected value"    │
  │  vitest.config.ts · 261 tests · sub-second  │
  │  injected fakes for Anthropic + MCP         │
  │  runs on every push / PR                    │  ← this guide
  └─────────────────────────┬───────────────────┘
                            │
                            │  seam: what does a test assert on?
                            │
  ┌─ npm run eval (eval/) ──▼───────────────────┐
  │  PROBABILISTIC — "good enough / no regress" │
  │  vitest.eval.config.ts · 10 goldens ·       │
  │  ~$0.15/case · gated by baseline.json       │
  │  LLM-as-judge · offline; excluded from `npm test`
  └─────────────────────────────────────────────┘
                            ↑
                            └── these findings live in `study-ai-engineering`,
                                not here. Cross-linked at each seam-touch.
```

**The rule:** if a test asserts a specific value on a deterministic
seam (JSON parse fallback → `Insufficient…`; `decodeConfigHeader('bad')`
→ `null`), it's here. If a test asserts a threshold on a
non-deterministic output (`root_cause_plausibility ≥ 4`), it's an eval
and lives in `study-ai-engineering`. **They MEET** on tests that wrap
the probabilistic core in a deterministic harness — that's the whole
strategy of `test/agents/diagnostic.test.ts`, and it earns its own
pattern file.

═════════════════════════════════════════════════
READING ORDER
═════════════════════════════════════════════════

1. **`00-overview.md`** — the audit at a glance. Coverage map, three
   highest-leverage gaps, one-line verdict per lens.
2. **`audit.md`** — the 7-lens walk. What each lens actually finds in
   this repo (with `file:line`), or `not yet exercised` honestly.
3. **`01-…` through `06-…`** — six discovered testing patterns the
   repo applies deliberately. Each uses the full concept-file template.

```
  .aipe/study-testing/
    README.md                                    (you are here)
    00-overview.md                               map + gaps
    audit.md                                     the 7 lenses
    01-scripted-anthropic-fake.md                Pass 2
    02-scripted-mcp-caller-fake.md               Pass 2
    03-http-transport-mock-with-module-hoisting.md   Pass 2
    04-fake-timer-time-travel-for-rate-limits.md Pass 2
    05-fixture-anchored-schema-tests.md          Pass 2
    06-fail-safe-decode-contract-tests.md        Pass 2
```

═════════════════════════════════════════════════
CROSS-LINKS
═════════════════════════════════════════════════

- **`study-ai-engineering`** — the eval harness (goldens, rubrics,
  judge, baseline gate) is the probabilistic half of the seam.
- **`study-software-design`** — "hard to test" surfaces there as a
  design smell (deep modules are easy to test). Referenced from lens 3.
- **`study-system-design`** — the streaming NDJSON contract, the
  `McpClient` cache + rate-limit shape, and the OAuth boundary are
  system-design patterns; here we test them, there we teach them.
