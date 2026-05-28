# 02 — Context and prompts

How blooming insights packs work into the model's finite context and wires multi-step prompting. Three concepts: the fixed buffer everything competes for, the positional bias that determines which packed content the model actually uses, and the chain that splits one big task into single-job model calls. Each file is a full per-concept study sheet (Why care → How it works → primary diagram → In this codebase → Elaborate → Tradeoffs → Tech reference → Project exercises → Summary → Interview defense → Validate).

## Index

- **[01-context-window.md](01-context-window.md)** — The context window is one fixed-size array shared by the system prompt, every turn, every tool result, and the answer's reserved room. blooming insights bounds every inflow in *characters* (`truncate`/`MAX_TOOL_RESULT_CHARS = 16_000`, route `TRUNC = 4000`, `schemaSummary` caps) and reserves output room with the forced tool-less final turn (`forceFinal` at base.ts L91, tools withheld at L101). Coarse but free; no `res.usage` meter behind it. (C1.2, deferred)
- **[02-lost-in-the-middle.md](02-lost-in-the-middle.md)** — Attention is U-shaped over position: content at the start and end is recalled, the middle is a dead zone. No retrieval to reorder, so the mitigation is purely positional — `synthesisInstruction` appended LAST (base.ts L98), tool results as the MOST RECENT turn (base.ts L171), and `synthesize()` collapsing the context entirely. A thin surface; the real fix (retrieval + reranking) is Case B → ../03-retrieval-and-rag/07-reranking.md. (C1.2, deferred/learn-only)
- **[03-prompt-chaining.md](03-prompt-chaining.md)** — The morning briefing is a fixed chain monitoring → diagnostic → recommendation, sequenced by plain `await` (route.ts L145–L161), each link one job with its own prompt/tools/validator/fallback and an isolated failure boundary; plus a gather→`synthesize()` micro-chain inside two links. Per-step model tiering is the un-taken optimization (all links use `AGENT_MODEL`, base.ts L9). Cross-link → ../04-agents-and-tool-use/01-agents-vs-chains.md. (Phase 1, C1.10)

## How to read this section

Read in order: **01 → 02 → 03**. `01-context-window.md` establishes the finite shared buffer everything else competes for; `02-lost-in-the-middle.md` is the natural sequel — *given* a packed window, position decides which content the model actually uses; `03-prompt-chaining.md` zooms out to how the whole briefing is wired as a sequence of single-job calls across that bounded context.

- **Codebase strength:** `03-prompt-chaining.md` — the briefing chain is blooming insights doing the textbook thing well: fixed path, single-job links, typed handoffs, isolated failures, a bounded agent inside each link.
- **Deferred / thin surfaces named honestly:** `01` bounds the window by characters with no token meter (`res.usage` absent); `02` mitigates lost-in-the-middle only by recency placement because there is no retrieval/reranker — both state the ceiling plainly and point at the real fix.

All citations are to blooming insights files (verified line numbers) and curriculum IDs for provenance only.
