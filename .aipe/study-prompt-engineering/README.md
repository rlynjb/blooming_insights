# Prompt engineering — study guide

Thirteen concept files, walked in the order a working AI engineer would walk them. Operational discipline first (how a production prompt is built, validated, versioned, budgeted, and iterated against evals). Specific techniques after (few-shot, CoT, self-critique, meta-prompting). Defense and forbidden patterns last.

Anchored to `blooming_insights`: five agents — monitoring, diagnostic, recommendation, query, intent — each driving a Bloomreach Engagement workspace through the loomi MCP server. The active prompts ship through `@aptkit/core` (the runtime); the prose source-of-truth for each Bloomreach-only prompt lives in `lib/agents/legacy-prompts/*.md`. When a concept exists as a pattern but the substrate is missing in this repo (eval harness, prompt-version logging in production), the file says so honestly.

## Reading order

Start at `00-overview.md` for the system map (where prompts live, who calls them, how outputs are validated). Then the thirteen concept files in order — each builds on the previous.

```
operational discipline                  techniques                            defense / hygiene
─────────────────────                   ──────────                            ─────────────────
01 anatomy                              08 few-shot                           12 prompt-injection-defense
02 structured-outputs                   09 chain-of-thought                   13 forbidden-patterns
03 prompts-as-code                      10 self-critique
04 token-budgeting                      11 meta-prompting
05 eval-driven-iteration
06 single-purpose-chains
07 output-mode-mismatch
```

## The thirteen concepts

| #  | File                              | One-line                                                                          |
|----|-----------------------------------|-----------------------------------------------------------------------------------|
| 01 | `01-anatomy.md`                   | Four sections of a production prompt; one job per section, named explicitly.      |
| 02 | `02-structured-outputs.md`        | Tool-calling and schema enforcement; never "respond only in JSON" in prose.       |
| 03 | `03-prompts-as-code.md`           | Markdown templates as version-controlled source; prompt + model version pairing.  |
| 04 | `04-token-budgeting.md`           | Counting tokens, the 80% rule, schema summarisation, prefix caching.              |
| 05 | `05-eval-driven-iteration.md`     | Golden set, regression suite, change-prompt-then-measure (Case B: substrate gone).|
| 06 | `06-single-purpose-chains.md`     | Five agents, five jobs; debugging benefit, model-routing benefit.                 |
| 07 | `07-output-mode-mismatch.md`      | Every chain declares one output mode; mismatches break parsers silently.          |
| 08 | `08-few-shot.md`                  | Examples constrain output more than instructions; when to use, when to skip.      |
| 09 | `09-chain-of-thought.md`          | The reasoning prompt; when it helps, when it wastes tokens.                       |
| 10 | `10-self-critique.md`             | Self-critique and self-consistency; 2–5x token cost for one extra reliability step.|
| 11 | `11-meta-prompting.md`            | Using an LLM to draft prompts for other LLM calls; aipe's slash-command shape.    |
| 12 | `12-prompt-injection-defense.md`  | Instruction hierarchies, input delimiters, output schemas as defense-in-depth.    |
| 13 | `13-forbidden-patterns.md`        | LLMs converge on phrasings; rotate openings, enumerate forbidden formulas.        |

## Where the concepts live in this repo

The active spine — `lib/agents/{monitoring,diagnostic,recommendation,query,intent}.ts` — each instantiates an AptKit agent class. The prose-source-of-truth for each Bloomreach-only prompt lives at `lib/agents/legacy-prompts/{monitoring,diagnostic,recommendation,query}.md`. Schema compaction lives in `lib/agents/monitoring.ts` as `schemaSummary(schema)`. Type guards at the boundary live in `lib/mcp/validate.ts` (legacy parser) and the AptKit validators inside the package. The forced-final-synthesis-turn discipline lives in `lib/agents/base-legacy.ts:114-156`.

## What is NOT here

- No `eval/` pipeline. The 4-pillar eval suite and LLM-as-judge harness do not exist in this repo today. Concept 05 names this honestly as Case B.
- No vendor-specific prompt syntax tour (XML tags, JSON-mode specifics). These appear inside concept files where they matter, not as their own concepts.
- No Tree of Thoughts, no constitutional AI, no vision/multi-modal prompting — none exercised by this codebase.
- No jailbreak research from the attacker side. The defender side (concept 12) is what matters for app builders.
