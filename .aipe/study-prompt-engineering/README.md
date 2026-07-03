# study-prompt-engineering — reading order

Thirteen concepts, ordered so the operational discipline lands before the specific techniques. If you read them in order, you get: how a real production prompt is shaped, how you keep it honest across model upgrades, how you know it's not silently regressing, and only then the technique-flavored moves (few-shot, chain-of-thought, self-critique, meta).

Anchored to blooming_insights — a Next.js app that ships a monitoring / diagnostic / recommendation agent chain over MCP-shaped Bloomreach tools, with a running eval harness (10 goldens, 4-dimension rubric judge, per-case receipts). Real file paths, real numbers from the baseline run `2026-07-03T04-08-28-644Z`.

## The 13 concepts

| # | File | One-liner |
|---|---|---|
| 00 | `00-overview.md` | The whole prompt surface of this repo in one map. |
| 01 | `01-anatomy.md` | The four sections of a production prompt (system / context / examples / user). |
| 02 | `02-structured-outputs.md` | JSON mode / tool calling / validator on the way out. |
| 03 | `03-prompts-as-code.md` | Prompts under version control; markdown-in-repo, not runtime strings. |
| 04 | `04-token-budgeting.md` | schemaSummary, tool-result truncation, prompt caching as levers. |
| 05 | `05-eval-driven-iteration.md` | The 10-golden harness. Rubric judge. Receipts. Regression suite. |
| 06 | `06-single-purpose-chains.md` | Monitor → Diagnose → Recommend. Each chain does one job. |
| 07 | `07-output-mode-mismatch.md` | Every chain declares its output shape. Where mismatches bite. |
| 08 | `08-few-shot.md` | Examples constrain shape more than instructions do. |
| 09 | `09-chain-of-thought.md` | Reasoning fields inside the structured output, not free-form prose. |
| 10 | `10-self-critique.md` | The rubric judge as self-critique-shaped, but with a second agent. |
| 11 | `11-meta-prompting.md` | Using an LLM to write / improve prompts. When it pays. |
| 12 | `12-prompt-injection-defense.md` | Instruction hierarchies, delimiters, structured output as defense. |
| 13 | `13-forbidden-patterns.md` | Rotating formulas, forbidden openings, drift over repeated runs. |

## Suggested reading order

**Foundations (read first):**
- 01 · anatomy
- 02 · structured outputs
- 03 · prompts as code
- 04 · token budgeting
- 05 · eval-driven iteration

**Composition (read next):**
- 06 · single-purpose chains
- 07 · output mode mismatch

**Techniques (read as needed):**
- 08 · few-shot
- 09 · chain-of-thought
- 10 · self-critique
- 11 · meta-prompting

**Safety and drift (last):**
- 12 · prompt injection defense
- 13 · forbidden patterns

## What's deliberately not here

- Vendor-syntax quirks. XML tags, `<answer>` conventions, OpenAI-specific `response_format` fields — those appear inside concept files where they earn a mention, not as concepts of their own.
- Tree of Thoughts, constitutional AI, jailbreak research. Real work, not what this codebase exercises.
- Multi-modal / vision prompting. Not in this repo.
