# blooming insights — prompt engineering study guide

The third companion to [`study-system-design/`](../study-system-design/README.md) and [`study-ai-engineering/`](../study-ai-engineering/README.md). Same per-concept template, but a different voice — **working AI engineer**, not staff engineer: first-person, concrete about bugs, skeptical of advice that only works in demos. 13 concepts, the complete list for the discipline.

The subject is blooming insights' four prompts — `lib/agents/prompts/{monitoring,diagnostic,recommendation,query}.md` — read as the versioned, budgeted, validated components they are. Start with [`00-overview.md`](00-overview.md) for the discipline map and the per-concept failure modes.

## Reading order

Operational discipline first (you can't iterate a prompt you can't budget or evaluate), then the specific techniques.

**Operational discipline**

1. **[01-anatomy.md](01-anatomy.md)** — the four sections of a production prompt; constant (system) vs per-call (injected); the decomposition rule. *C1.7.*
2. **[02-structured-outputs.md](02-structured-outputs.md)** — extracting a typed contract from prose: fence-strip, validate, retry; why prompt-instructed JSON survives here. *NEW Tier 1.*
3. **[03-prompts-as-code.md](03-prompts-as-code.md)** — prompts as version-controlled source; the prompt+model-version pairing gap. *NEW Tier 1.*
4. **[04-token-budgeting.md](04-token-budgeting.md)** — counting tokens as basic hygiene; schema/result/tool-call caps; the unused prefix-cache. *NEW Tier 1.*
5. **[05-eval-driven-iteration.md](05-eval-driven-iteration.md)** — iterate against a golden set, not vibes; the informal regression suite hiding in the prompts. *NEW Tier 1.*

**Specific techniques**

6. **[06-single-purpose-chains.md](06-single-purpose-chains.md)** — one job per chain, each disclaiming the others; debugging and model-routing payoffs. *C1.10.*
7. **[07-output-mode-mismatch.md](07-output-mode-mismatch.md)** — 3 JSON agents + 1 prose agent; declaring and enforcing the mode at the boundary. *C1.12.*
8. **[08-few-shot.md](08-few-shot.md)** — examples constrain format better than instructions; format-shaping few-shot vs the zero-shot classifier. *existing.*
9. **[09-chain-of-thought.md](09-chain-of-thought.md)** — reasoning in a structured `hypothesesConsidered` field, not free prose; when CoT hurts. *existing.*
10. **[10-self-critique.md](10-self-critique.md)** — critique/revise and N-run voting; why `synthesize()` is recovery, not critique. *NEW Tier 2.*
11. **[11-meta-prompting.md](11-meta-prompting.md)** — using an LLM to draft prompts; when it saves time, and the spec-vs-LLM-voice risk. *NEW Tier 2.*
12. **[12-prompt-injection-defense.md](12-prompt-injection-defense.md)** — author-side defenses for the open `?q=` path; defense-in-depth with the runtime layers. *NEW Tier 1 (C5.7).*
13. **[13-forbidden-patterns.md](13-forbidden-patterns.md)** — negative-constraint instructions (used heavily) and rotating formulas (correctly absent). *existing.*

## Case A vs Case B

**Case A** (implemented, cited to real `file:line`): anatomy, structured outputs, single-purpose chains, output-mode mismatch, token budgeting, chain-of-thought, and the negative-constraint half of forbidden-patterns. **Case A-partial:** prompts-as-code (no model pairing logged), few-shot (format-shaping only; the classifier is zero-shot).

**Case B** (full study material + a blooming-insights-targeted buildable exercise): eval-driven iteration (no harness), self-critique (only recovery exists), meta-prompting (prompts are hand-written), prompt-injection defense (open `?q=`, bounded by read-only tools + validators), and the rotating-formulas half of forbidden-patterns.

> Curriculum-loaded: each file carries a `## Project exercises` block citing `aieng-curriculum.md` concept IDs (C1.7, C1.10, C1.12, C3.1–C3.3, C5.7, plus the NEW Tier-1/Tier-2 concepts) for provenance, with every exercise targeting blooming insights' own files.
