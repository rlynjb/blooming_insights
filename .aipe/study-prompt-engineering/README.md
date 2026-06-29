# Study — prompt engineering, anchored to blooming insights

A working AI engineer's notebook on the prompt-engineering discipline as it shows up in this repo. The agents you'll read about — monitoring, diagnostic, recommendation, query, intent — live under `lib/agents/`. The prompt templates they consume live at `lib/agents/legacy-prompts/{monitoring,diagnostic,query,recommendation}.md`. The validator at the model-output boundary lives at `lib/mcp/validate.ts`. Every concept file points at one of these.

## Reading order

Operational discipline first, specific techniques after. If you read this in order, the early files give you the framing the later ones lean on (structured outputs assumes you understand the four prompt sections; eval-driven iteration assumes you've thought about prompts as code).

1. [00-overview.md](./00-overview.md) — the system in one frame, the prompt-engineering surface highlighted
2. [01-anatomy.md](./01-anatomy.md) — the four prompt sections, how blooming's templates decompose them
3. [02-structured-outputs.md](./02-structured-outputs.md) — JSON in a fence, parser at the boundary, type guards on the way back
4. [03-prompts-as-code.md](./03-prompts-as-code.md) — `.md` files in git, slot interpolation, the aptkit handoff
5. [04-token-budgeting.md](./04-token-budgeting.md) — the schema-summary helper, the per-result truncation, the 6-tool budget
6. [05-eval-driven-iteration.md](./05-eval-driven-iteration.md) — the test suite at the model-output boundary, the gap
7. [06-single-purpose-chains.md](./06-single-purpose-chains.md) — five agents, one job each, the coordinator that routes
8. [07-output-mode-mismatch.md](./07-output-mode-mismatch.md) — JSON-mode prompts vs prose-mode prompts, the fence convention
9. [08-few-shot.md](./08-few-shot.md) — the worked anomaly example in `monitoring.md`, why classifiers want examples
10. [09-chain-of-thought.md](./09-chain-of-thought.md) — the "generate 2–3 hypotheses before your first tool call" pattern
11. [10-self-critique.md](./10-self-critique.md) — the one-turn recovery path, what it doesn't catch
12. [11-meta-prompting.md](./11-meta-prompting.md) — the category checklist generated from runtime capabilities
13. [12-prompt-injection-defense.md](./12-prompt-injection-defense.md) — the QueryBox surface, instruction hierarchies, capability gating
14. [13-forbidden-patterns.md](./13-forbidden-patterns.md) — what's NOT here yet, where the rotation problem would land

## What this notebook is, and isn't

It's a teaching artifact about prompt engineering in production, taught off this codebase. It reads concept → mechanism → real file you can open. Where the codebase doesn't exercise a concept yet, the file says so honestly and names what a buildable target would look like.

It isn't a spec for what the prompts should say. The prompts in `lib/agents/legacy-prompts/` are the source of truth for product behavior; this notebook reads them and explains the patterns they exemplify.
