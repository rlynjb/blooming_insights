# Prompt engineering — one-page map

Prompt engineering is the discipline of shipping LLM-backed features that survive Friday deploys, model upgrades, and PMs who ask you to "make it more creative." It is not writing better prompts. It is treating a prompt like production code — versioned, tested, evaled, budgeted, observable — and knowing which of the folklore techniques (chain-of-thought, few-shot, self-critique) actually earn their tokens for the problem you have.

## Where each concept sits in the stack

```
  Prompt engineering — the stack

  ┌─ discipline (how you work) ─────────────────────────────┐
  │  01 anatomy         03 prompts-as-code                  │
  │  05 eval-driven     04 token budgeting                  │
  │  02 structured outputs (contract at the boundary)       │
  └─────────────────────────────────────────────────────────┘
              │
              ▼
  ┌─ techniques (what you reach for) ───────────────────────┐
  │  06 single-purpose chains    07 output mode mismatch    │
  │  08 few-shot                 09 chain-of-thought        │
  │  10 self-critique            11 meta-prompting          │
  │  13 forbidden patterns / rotating formulas              │
  └─────────────────────────────────────────────────────────┘
              │
              ▼
  ┌─ hardening (what breaks in production) ─────────────────┐
  │  12 prompt injection defenses                           │
  └─────────────────────────────────────────────────────────┘
```

Read top to bottom. If you know discipline but jump straight to techniques you'll ship prompts that work in demos and regress silently in production.

## The 13 concepts — what each one gets wrong when done badly

**Operational discipline (read first):**

- **01 · Anatomy of a production prompt** — junior mode dumps everything into one string. Sections drift, and now no one can change the schema line without breaking the role line. Fix: name the four sections explicitly.
- **02 · Structured outputs** — "respond only in JSON" in a system prompt was the 2023 answer. In 2026 you use tool calling or `response_format`, validate the parse, retry with a stricter re-ask on schema fail. The bug: courteous models wrapping JSON in markdown fences.
- **03 · Prompts as code** — prompts scattered as string literals across a repo cannot be reviewed, diffed, or version-paired with model versions. In this codebase the prompts live inside `@aptkit/core` as versioned template packages — that shape is the concept.
- **04 · Token budgeting** — a chain that works fine on small inputs times out at scale because nobody counted tokens. In this codebase `schemaSummary()` caps the workspace schema to 20 events × 10 properties + 30 customer properties. That cap is the concept.
- **05 · Eval-driven iteration** — vibes-based iteration means every prompt tweak is a stab in the dark. Golden set + judge + receipt is the discipline. This codebase has all three: 10 goldens, `RubricJudge`, per-case receipts.

**Techniques (reach for these when the problem calls for them):**

- **06 · Single-purpose chains** — one chain doing four jobs is where brittleness hides. This codebase runs four agents (`monitoring`, `diagnostic`, `recommendation`, `query`), each with one job, composed in the coordinator.
- **07 · Output mode mismatch** — chain A returns JSON in a fence, chain B expects markdown, parser breaks. The failure mode is silent — schema validators catch it if you write them.
- **08 · Few-shot prompting** — three good examples beats an instruction paragraph for format-sensitive tasks. Overused for open-ended generation, where they lock the model into repetition.
- **09 · Chain-of-thought** — 2023's "let's think step by step" is largely subsumed by modern models doing CoT internally. The residue is still useful for cheaper models and structured hypothesis-testing loops.
- **10 · Self-critique** — a model critiquing its own output has the same blind spots that produced the output. It works when the failure mode is "over-eager" (invented numbers), not "under-informed" (missing tool).
- **11 · Meta-prompting** — using an LLM to draft prompts is fine as a first draft; it is not fine as the last step before production. The risk is prompts that read like LLM output instead of engineering specs.
- **13 · Forbidden patterns** — LLMs converge on phrasings. Every caption from the same chain will start "Here's a" unless you name the forbidden opening and enumerate rotations.

**Hardening (the security seam):**

- **12 · Prompt injection defenses** — the second the prompt interpolates user-controlled content, the model is one clever payload away from following the user's instructions instead of yours. Defense-in-depth: instruction hierarchy in the system prompt, delimiter framings around user content, structured output as a defense, output validation.

## Reading order

If you're new to the discipline: read **01 → 02 → 03 → 04 → 05** in order. Those five are the substrate — everything else assumes them. Then read the techniques (06–11, 13) in the order the problem in front of you demands. Read **12** before shipping anything that takes user input.
