# Prompt engineering — the discipline, mapped to this codebase

Prompt engineering, the way it survives production, is not "wording tricks" — it is the engineering discipline of treating a prompt as a versioned, budgeted, injectable component with a typed boundary around it. blooming insights is a clean specimen, but with a twist worth naming up front: the **active prompts now ship through an npm package** (`@aptkit/prompts`, pulled in via `@aptkit/core@0.3.0`), while the previous markdown prompts are preserved under `lib/agents/legacy-prompts/` and exercised by the four `*-legacy.ts` agents only. Both paths assemble a Claude call with injected context, are bounded by a tool-call budget, and parse back through a validator that refuses to trust the model's prose. This guide reads those prompts — package-shipped and legacy alike — as the artifact they are, and names, for each of the 13 concepts, what the codebase does, what it deliberately doesn't, and the production failure mode the concept exists to prevent.

```
┌─ authoring (source) ──────────────────────────────────────────────┐
│  active path:  @aptkit/prompts (npm package, via @aptkit/core)    │
│  legacy path:  lib/agents/legacy-prompts/{monitoring,diagnostic,  │
│                recommendation,query}.md                            │
│   Role · Hard rules · method · EQL reminders · Output · {schema}   │
└───────────────┬───────────────────────────────────────────────────┘
                │ active: package import        [01,03,06,07,14]
                │ legacy: readFileSync at module load
                ▼
┌─ assembly (per call) ─────────────────────────────────────────────┐
│  system = prompt  +  injected {project_id}/{anomaly}/{diagnosis}/  │
│  {intent}/{schema}  +  userPrompt   +  synthesisInstruction(final) │
│  budget: maxToolCalls 6/6/4/6 · max_tokens 4096/2048/16            │
│   anatomy [01] · token budget [04] · few-shot/EQL [08] · CoT [09]  │
└───────────────┬───────────────────────────────────────────────────┘
                │ claude-sonnet-4-6 (agents) · haiku (classifier)
                ▼
┌─ output boundary ─────────────────────────────────────────────────┐
│  parseAgentJson (strip ```json fence → bare → scan)               │
│  type guards → synthesize() retry → FALLBACK                       │
│   structured outputs [02] · output-mode mismatch [07]             │
│  query path: prose, NO validator, user ?q= interpolated  [12]      │
└───────────────┬───────────────────────────────────────────────────┘
                │ no in-repo eval harness; scoring is off-path
                ▼
   what's MISSING (the buildable gaps)
   eval-driven iteration harness [05] · self-critique [10]
   meta-prompting [11] · injection delimiters [12]
   rotating formulas if a digest is added [13]
   prompt-package version → output co-logging [03,14]
```

## The 13 concepts — grouped, with the failure mode each prevents

**Operational discipline (read first):**

- **[01 anatomy](01-anatomy.md)** — *Prevents:* prompt drift, where mixing constant and per-call content into one blob makes every change a guess. blooming insights: the shared Role/Hard-rules/Output/`{schema}` shape, now sourced from `@aptkit/prompts` on the active path and preserved as `.md` files on the legacy path. **Case A.**
- **[02 structured outputs](02-structured-outputs.md)** — *Prevents:* the parser breaking when a courteous model wraps JSON in a markdown fence. blooming insights: prompt-instructed fenced JSON + `parseAgentJson` fence-strip + type guards + retry. **Case A.**
- **[03 prompts as code](03-prompts-as-code.md)** — *Prevents:* a prompt that worked on one model silently breaking on the next, with no record of the pairing. blooming insights: prompts live in source — either as a versioned npm package (`@aptkit/prompts`) on the active path or as `.md` files in `lib/agents/legacy-prompts/`; the model-ID pairing and the package-version → output co-log are the honest gaps. **Case A-partial.**
- **[04 token budgeting](04-token-budgeting.md)** — *Prevents:* a chain that worked on small inputs truncating or timing out at scale because nobody counted. blooming insights: `schemaSummary` caps, char budgets, tool-call caps — no prefix caching. **Case A.**
- **[05 eval-driven iteration](05-eval-driven-iteration.md)** — *Prevents:* iterating by vibes and shipping a "better" prompt that regresses an untracked edge case. blooming insights: the PATTERN is real prompt-engineering work, but there is no in-repo eval harness now — the `eval/` suite and its receipts are gone. The CRITICAL/Never/Do NOT blocks in the legacy prompts are still informal regression encoding; the formal harness is the buildable target. **Case B.**

**Specific techniques:**

- **[06 single-purpose chains](06-single-purpose-chains.md)** — *Prevents:* a multi-purpose chain that's brittle, expensive to fail, and hard to debug. blooming insights: monitoring/diagnostic/recommendation each scoped and disclaiming the others. **Case A.**
- **[07 output-mode mismatch](07-output-mode-mismatch.md)** — *Prevents:* chain A emits JSON, chain B expects prose, the parser breaks. blooming insights: 3 JSON agents + 1 prose agent, mode declared per prompt. **Case A.**
- **[08 few-shot](08-few-shot.md)** — *Prevents:* output that drifts because instructions alone don't constrain format. blooming insights: format-shaping examples (EQL reminders, JSON exemplars); the classifier is zero-shot. **Case A-partial.**
- **[09 chain-of-thought](09-chain-of-thought.md)** — *Prevents:* wrong multi-step conclusions, and free-form reasoning that pollutes a structured answer. blooming insights: hypotheses forced into the structured `hypothesesConsidered[].reasoning` field. **Case A.**
- **[10 self-critique](10-self-critique.md)** — *Prevents:* shipping a low-trust output with no verify step. blooming insights: `synthesize()` is recovery, not critique — true self-critique is unbuilt. **Case B.**
- **[11 meta-prompting](11-meta-prompting.md)** — *Prevents:* slow hand-drafting of complex prompts (and the risk of prompts that read like LLM output). blooming insights: prompts are hand-written; no generator. **Case B.**
- **[12 prompt-injection defense](12-prompt-injection-defense.md)** — *Prevents:* user `?q=` input carrying instructions the model obeys. blooming insights: trim-only input, no delimiters/hierarchy; read-only tools + validators bound the blast radius. **Case B (partial structural mitigations).**
- **[13 forbidden patterns](13-forbidden-patterns.md)** — *Prevents:* a generative chain converging on the same phrasing every run. blooming insights: heavy negative-constraint instructions; rotation correctly absent (structured/one-shot outputs). **Case A (constraints) / Case B (rotation).**

> Reading order, and the Case A/B split, live in [README.md](README.md). The companion guides are [`../study-ai-engineering/`](../study-ai-engineering/README.md) (the systems lens on the same agents) and [`../study-system-design/`](../study-system-design/README.md).

---
Updated: 2026-06-16 — Updated the eval row to Case A (Phase 3 `eval/` ships) and rebuilt the `what's MISSING` diagram band into "eval/ suite (Phase 3)" + a smaller residual gap list. Real receipt: monitoring Phase 2.5 fix → loose recall 6.7% → 33.3% with framing limit honestly named.
Updated: 2026-06-19 — AptKit migration + Olist removal: prompts now ship via `@aptkit/prompts` (active) with `lib/agents/legacy-prompts/` preserving the previous markdown (legacy). The Phase 3 `eval/` harness and its 6.7% → 33.3% receipt are gone — reverted 05 to Case B and removed the eval band from the architecture diagram. Updated 01 and 03 lines to name the package boundary as the new authoring seam.
