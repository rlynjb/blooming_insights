# 02 — Context and prompts

What goes into the model's context window, what gets dropped, and how multi-step flows split work across multiple LLM calls. Three concepts:

  1. `01-context-window.md` — the fixed container, what competes for space, how this codebase budgets
  2. `02-lost-in-the-middle.md` — why position matters, and where this codebase puts the most-important content
  3. `03-prompt-chaining.md` — the diagnose → recommend handoff as the canonical chain in this repo

Read in this order. Each file is short — the load-bearing content for prompt internals lives in `study-prompt-engineering/`.
