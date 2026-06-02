# Prompt engineering — the discipline, mapped to this codebase

Prompt engineering, the way it survives production, is not "wording tricks" — it is the engineering discipline of treating a prompt as a versioned, budgeted, evaluated, injectable component with a typed boundary around it. blooming insights is a clean specimen: four prompts live as `.md` files in `lib/agents/prompts/`, each loaded as source, assembled into a Claude call with injected context, bounded by a tool-call budget, and parsed back through a validator that refuses to trust the model's prose. This guide reads those four prompts as the artifact they are, and names — for each of the 13 concepts — what the codebase does, what it deliberately doesn't, and the production failure mode the concept exists to prevent.

```
┌─ authoring (source) ──────────────────────────────────────────────┐
│  lib/agents/prompts/{monitoring,diagnostic,recommendation,query}.md│
│   Role · Hard rules · method · EQL reminders · Output · {schema}   │
└───────────────┬───────────────────────────────────────────────────┘
                │ readFileSync (prompts-as-code)        [01,03,06,07]
                ▼
┌─ assembly (per call) ─────────────────────────────────────────────┐
│  system = file  +  injected {project_id}/{anomaly}/{diagnosis}/    │
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
                │ what's MISSING (the buildable gaps)
                ▼
   eval harness [05] · self-critique [10] · meta-prompting [11]
   injection delimiters [12] · rotating formulas if a digest is added [13]
```

## The 13 concepts — grouped, with the failure mode each prevents

**Operational discipline (read first):**

- **[01 anatomy](01-anatomy.md)** — *Prevents:* prompt drift, where mixing constant and per-call content into one blob makes every change a guess. blooming insights: the shared Role/Hard-rules/Output/`{schema}` shape across four files. **Case A.**
- **[02 structured outputs](02-structured-outputs.md)** — *Prevents:* the parser breaking when a courteous model wraps JSON in a markdown fence. blooming insights: prompt-instructed fenced JSON + `parseAgentJson` fence-strip + type guards + retry. **Case A.**
- **[03 prompts as code](03-prompts-as-code.md)** — *Prevents:* a prompt that worked on one model silently breaking on the next, with no record of the pairing. blooming insights: `.md` files under version control; the model-ID pairing is the honest gap. **Case A-partial.**
- **[04 token budgeting](04-token-budgeting.md)** — *Prevents:* a chain that worked on small inputs truncating or timing out at scale because nobody counted. blooming insights: `schemaSummary` caps, char budgets, tool-call caps — no prefix caching. **Case A.**
- **[05 eval-driven iteration](05-eval-driven-iteration.md)** — *Prevents:* iterating by vibes and shipping a "better" prompt that regresses an untracked edge case. blooming insights: no harness yet — the prompts' "CRITICAL/Never" blocks are an informal regression suite in prose. **Case B.**

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
