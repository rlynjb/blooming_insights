# 02 — context and prompts

The context window is the model's whole world per call. Everything you ship —
system prompt, schema summary, tool definitions, the conversation so far,
the response space — competes for one finite budget. This section walks how
blooming insights manages that budget.

## Files

```
01-context-window.md      ← the finite container; how this codebase budgets it
02-lost-in-the-middle.md  ← attention biases; partially exercised
03-prompt-chaining.md     ← monitoring → diagnostic → recommendation (LOAD-BEARING)
```

## What's load-bearing in this section

  → **`03-prompt-chaining.md`** — the three-agent chain IS the product. The
    investigate page splits diagnose (step 2) and recommend (step 3) into
    separate route calls so the user can stop after the diagnosis. Read
    this to understand why there are five agents, not one.

  → **`01-context-window.md`** — `schemaSummary()` is the budget gate.
    Without the 20/10/30 truncation, a 6-turn diagnostic loop would
    burn ~180k input tokens and approach the Sonnet 4 context window.

## What's pattern-only (Case B)

  → **`02-lost-in-the-middle.md`** — the codebase doesn't stuff long lists
    of retrieved docs into context (there's no RAG; see 03-retrieval-and-rag).
    But the *category checklist* the monitoring agent gets IS a list of
    10 things, and the order matters. Taught with the partial-anchor.
