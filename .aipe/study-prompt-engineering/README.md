# Prompt engineering — index

Thirteen concepts, anchored to `blooming_insights`. Written in a working AI engineer voice — practitioner-skeptical, concrete-over-abstract, demo-vs-prod aware. If you're new here, read `00-overview.md` first for the one-page map.

## Reading order

The order below is not the alphabetical order of the files — it's the order to learn the discipline in. Operational discipline first (01–05); techniques second (06–11, 13); the security seam last (12).

**Operational discipline — the substrate**

1. `01-anatomy.md` — Anatomy of a production prompt. Four named sections, one job each.
2. `02-structured-outputs.md` — Tool calling and schemas as the modern contract, not "respond in JSON."
3. `03-prompts-as-code.md` — Version-controlled, reviewed, model-version-paired prompts.
4. `04-token-budgeting.md` — Counting tokens, the 80% rule, prefix caching, `schemaSummary`.
5. `05-eval-driven-iteration.md` — Goldens, LLM-as-judge, receipts, regression suites.

**Techniques — reach for them when the problem asks**

6. `06-single-purpose-chains.md` — One chain per job, composed into a pipeline.
7. `07-output-mode-mismatch.md` — Every chain has one declared output mode; mismatches are silent.
8. `08-few-shot.md` — Examples beat instructions for format-sensitive tasks.
9. `09-chain-of-thought.md` — Reasoning prompts, when they earn their tokens.
10. `10-self-critique.md` — Verify steps, self-consistency, and the blind-spot problem.
11. `11-meta-prompting.md` — LLMs writing prompts, and where that stops being useful.
13. `13-forbidden-patterns.md` — Rotating formulas for repeatable generative chains.

**The security seam**

12. `12-prompt-injection-defense.md` — Author-side defenses when the prompt eats user input.

## What this guide is not

- Not a vendor cookbook. Vendor-specific quirks (Anthropic prefers XML tags, OpenAI's JSON mode syntax) appear inside concept files where they matter, not as their own concepts.
- Not academic prompt research. Tree of Thoughts, Constitutional AI, and jailbreak-attacker research are out of scope. If a technique isn't running in production somewhere, it's not in this guide.
- Not multimodal. This codebase is text-in / text-out. Vision prompting stays out.
- Not history. This is a working reference, not a timeline of how prompt engineering became a thing.
