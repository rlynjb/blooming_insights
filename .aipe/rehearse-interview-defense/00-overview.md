# Overview — the blooming insights defense book

  ## What this book is

You've spent months on this project. You've shipped it. Now an interviewer is about to ask you to defend it in the first ten minutes of a loop, in the middle of a system design round, in a chat that started casual and turned technical when they leaned in. This book is the coach in the room with you before that conversation.

It teaches you to defend blooming insights — the multi-agent AI analyst (`app/api/briefing`, `app/api/agent`, `lib/agents/*`, the AptKit primitive boundary, the DataSource port, the eval flywheel, the fault-injecting decorator, the regression gate) as a whole system. Not one concept. The whole story: the pitch, the architecture, the choices, the scale, the failures, the hard parts, the counterfactuals, and the AI question.

  ## What blooming insights actually is, at a glance

The visual anchor you keep coming back to. Every chapter opens with its own diagram; this is the one that stitches them.

```
  blooming insights — the system at a glance

  ┌─ Browser / UI (React 19, Tailwind v4) ─────────────────────────┐
  │  app/page.tsx (461 LOC)  +  3 hooks:                            │
  │    useBriefing · useLiveMode · useInvestigation                 │
  │  StatusLog + ReasoningTrace  ←  streams agents' thinking        │
  │  readNdjson kernel (64 LOC, 4 streaming consumers)              │
  └────────────────────────┬───────────────────────────────────────┘
                           │  fetch() → NDJSON over ReadableStream
  ┌─ Route layer (Next.js 16 App Router, edge=off) ─────────────────┐
  │  /api/briefing   → monitoring agent → Insight[]                 │
  │  /api/agent      → diagnostic / recommendation / query          │
  │  session-keyed Map<sessionId, SessionFeed> (concurrent-safe)    │
  └────────────────────────┬───────────────────────────────────────┘
                           │
  ┌─ Agent layer (@aptkit/core@0.3.0) ──────────────────────────────┐
  │  5 agents:                                                      │
  │    monitoring · diagnostic · query · recommendation             │
  │    + Haiku classifyIntent                                       │
  │  Bridge: lib/agents/aptkit-adapters.ts (~263 LOC)               │
  │    AnthropicModelProviderAdapter                                │
  │    BloomingToolRegistryAdapter                                  │
  │    BloomingTraceSinkAdapter                                     │
  │  Legacy loop preserved: lib/agents/*-legacy.ts (rollback)       │
  │  BudgetTracker · pricing.ts (Anthropic-priced, not OpenAI)      │
  └────────────────────────┬───────────────────────────────────────┘
                           │  DataSource port (71 LOC, 5 uses)
  ┌─ Provider layer ────────▼───────────────────────────────────────┐
  │  McpDataSource (generic; alias re-export of BloomreachDataSource)│
  │    · Bloomreach is the DEFAULT preset, not the identity         │
  │    · per-request McpConfigOverride (url · authType · bearer)    │
  │  SyntheticDataSource        (default UX: live-synthetic)        │
  │  FaultInjectingDataSource   (decorator, 4 fault modes)          │
  │       │                                                         │
  │       ▼                                                         │
  │  AuthProvider strategy (OAuthClientProvider conformance)        │
  │    · BloomreachAuthProvider (OAuth PKCE + DCR)                  │
  │    · BearerAuthProvider     (static token)                      │
  │    · AnonymousAuthProvider  (no auth)                           │
  │       │                                                         │
  │       ▼                                                         │
  │  ANY MCP server ────────►  target workspace                     │
  │  (30s per-call timeout · 300s route budget)                     │
  └─────────────────────────────────────────────────────────────────┘

  Off to the side: the eval flywheel
  ┌─────────────────────────────────────────────────────────────────┐
  │  eval/ — 10 goldens · 2 rubrics × 4 dims × 5-scale · baseline   │
  │  eval/gate.eval.ts (regression gate, GATE_MAX_REGRESSION=10pp) │
  │  eval/load.eval.ts (semaphore, LOAD_N/K)                        │
  │  eval/report.eval.ts (p50/p95/p99 from receipts)                │
  │  .github/workflows/ci.yml (typecheck · test · build on push/PR) │
  └─────────────────────────────────────────────────────────────────┘
```

The reader who only stares at this diagram for two minutes should be able to name the four bands, the two off-to-the-side scaffolds, and where the seam swaps live.

  ## The eight chapters

  **01 — The pitch.** The first 60 seconds. Ten seconds, thirty seconds, ninety seconds. What every interview opens with; what most candidates ramble through.

  **02 — The architecture.** The whiteboard walk. Four bands, one request, one investigation. The diagram you re-draw from memory in 90 seconds without hesitation.

  **03 — The choices.** Six load-bearing choices, plus a swappable-MCP defense (3b) and an in-flight briefing gate defense (3c) embedded in Choice 3. Framework (Next.js 16). Own loop → AptKit migration. DataSource seam (5 uses, 0 caller changes; Bloomreach is the default preset, not the codebase identity — the swappable-MCP receipt lives here; the route-level 409 gate for concurrent same-session briefings is the newest 3c fix on top of it). NDJSON over SSE. Deterministic supervisor. And the closer: the sequenced portfolio hardening plan, COMPLETE.

  **04 — The scale story.** Three scenarios (10× users · 100× investigations · 10× peak QPS). Real p50 numbers. The bottleneck named for each.

  **05 — The failure story.** The fault-injection receipt: 9 injected faults across 3 investigations, 0 investigation failures. How the AptKit agent loop presents `is_error:true` back to the model and lets it reason around the fault. Plus the concurrent-briefing race caught and fixed by a route-level in-flight gate — 8 tests, suite 268 → 276.

  **06 — The hard parts.** The `insights.ts` concurrent-user wipe (AI wrote it, you accepted it, you found the bug, you shipped the fix). The portfolio hardening plan shipped end-to-end. And the one you can't fully defend: the `actionable_next_step` 0% baseline.

  **07 — The counterfactuals.** What you'd reconsider before being asked. The monitoring-routing decision the eval flywheel prevented you from making blind. The blind calibration that was AI-vs-AI, stamped `pilotWarning`.

  **08 — The AI question.** The 2026 meta. Three decision modes: deliberate · evaluated-and-accepted · defaulted-to. Four things AI got wrong. One thing AI helped with. What OAuth PKCE + DCR taught you about defaulted-to.

  ## How to read this book

The first read: chapter by chapter, in order, one sitting per chapter. Chapters 1–3 are the wide opener (the pitch, the architecture, the choices). Chapters 4–5 are the systems layer (scale, failure). Chapters 6–7 are the reflective layer (hard parts, counterfactuals). Chapter 8 is the meta.

The second read: skim the visual treatments. The chapter-opening diagrams. The "WHAT THEY'RE REALLY ASKING" callouts. The strong/weak side-by-sides. The "I don't know" recovery boxes. The pull quotes. That's roughly 70% of the book.

The night before: read only the one-page summary at the end of each chapter. Twenty minutes total. The summaries carry the compressed form.

  ## The 2026 posture running through every chapter

You built this with heavy AI assistance. The senior-engineer move isn't to hide that. It's to name three decision modes explicitly:

```
  Three modes of decision-making — name them out loud

  ┌─ deliberate ─────────────────────────────────────┐
  │  You read the docs. You picked the option. You   │
  │  can defend the cost you're paying.              │
  │  Example: prompt caching config; NDJSON vs SSE   │
  └──────────────────────────────────────────────────┘
  ┌─ evaluated-and-accepted ─────────────────────────┐
  │  AI suggested. You evaluated against alternatives │
  │  you actually thought about. You accepted.        │
  │  Example: AptKit migration; legacy preserved.     │
  └──────────────────────────────────────────────────┘
  ┌─ defaulted-to ───────────────────────────────────┐
  │  AI's default. You didn't deeply evaluate. The   │
  │  senior-signal-positive move is to own that      │
  │  honestly and name the trigger to revisit.       │
  │  Example: OAuth PKCE + DCR shape.                 │
  └──────────────────────────────────────────────────┘
```

Every chapter's strong answers slot into one of these three. You'll notice you never fake mode-1 for a mode-3 decision. That's the tell an interviewer is watching for.

┃ "The strongest defense isn't denial. It's owning the
┃  decision and the cost you're paying for it."

  ## What's not in this book

Deep-dive concept files for individual patterns. Those live in `.aipe/study-system-design/`, `.aipe/study-ai-engineering/`, `.aipe/study-agent-architecture/`. Use those for the deep dive when an interviewer drills into one pattern. Use this book for the wide opener when they zoom out.

Both are needed. Study the concept files during the week; skim this book the night before.

  ## One last thing before you turn the page

The point of this book isn't to give you memorized lines. It's to give you the mental map of every conversation an interviewer can start, so no branch surprises you. When you know the branches, you can be present. When you can be present, you can be yourself. When you can be yourself, the interview stops being a performance and starts being a conversation.

That's the goal. Turn the page.
