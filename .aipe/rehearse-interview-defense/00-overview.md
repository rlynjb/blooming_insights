# blooming insights — interview defense book

This is your book for defending **blooming insights** as a whole project in a senior interview. Not a reference grid you look things up in — a book you read front to back once, then re-skim the night before. Eight chapters, in order, each one a continuous narrative that walks the interview questions in its territory and ends with a one-page summary you can review in two minutes.

The reader is you: a frontend engineer (7+ years, Vue/React, enterprise customers) pivoting into AI engineering, who built a multi-agent AI analyst. The book is written in your voice — every "strong answer" is first-person, present tense, and meant to be read aloud until it sounds like you. The coach writing it has sat on hiring committees and watched candidates collapse under follow-ups; the whole book is built around *not* collapsing.

## How to use this book

```
  FIRST READ          REVIEW              NIGHT BEFORE
  ──────────          ──────              ────────────
  chapters in order   skim each chapter's  read ONLY the
  one per sitting     visual treatments —  one-page summary
  front to back       diagrams, callouts,  at the end of each
                      pull quotes, the     chapter. Nothing else.
                      "I don't know" boxes
        │                   │                    │
        ▼                   ▼                    ▼
  build the whole     refresh the shape    walk in with the
  defense             without re-reading   pull quotes loaded
```

A reader who skims only the six recurring visual treatments — the chapter-opening diagrams, the "what they're really asking" callouts, the strong-vs-weak side-by-sides, the double-line "I don't know" boxes, the follow-up decision trees, and the pull quotes — gets roughly 70% of the book. The prose is there for the first deep read.

## The system at a glance

Every chapter leans on this picture; when you lose the thread mid-interview, this is what you re-anchor to.

```
┌─ UI (Next.js 16 App Router · React 19) ───────────────────────────────────────┐
│  feed (CoverageGrid + InsightCard + StatusLog)                                 │
│  investigate/[id] (diagnose)   …/recommend (decide)                            │
│       │ fetch /api/briefing       │ fetch /api/agent?step=…   (NDJSON reader)   │
└───────│───────────────────────────│────────────────────────────────────────────┘
        ▼  NDJSON over a ReadableStream — fetch + reader loop, not EventSource
┌─ Route handlers (Vercel · maxDuration = 300) ─────────────────────────────────┐
│  /api/briefing: bootstrap schema → coverage gate → monitoring scan → insights  │
│  /api/agent (step=diagnose|recommend): cache-replay (demo) OR live             │
│       ▼ runAgentLoop — one shared Claude tool-use loop (maxToolCalls + synth)   │
│   monitoring · diagnostic · recommendation · query   (claude-sonnet-4-6)        │
│       ▼ McpClient: 60s cache · ~1.1s spacing · bounded backoff · no-cache-on-err│
│   OAuthClientProvider (PKCE + DCR) · prod auth = AES-256-GCM `bi_auth` cookie    │
└──── state: in-memory maps + committed demo-*.json (NO DB) ── Bloomreach MCP · Anthropic ─┘
```

The spine: **UI → route → one shared agent loop → one MCP choke-point → providers**, no database in the middle. Chapter 2 walks it band by band.

## The eight chapters

```
01 ── THE PITCH            the project in 10s / 30s / 90s; compression discipline
02 ── THE ARCHITECTURE     the whiteboard walk + where they interrupt
03 ── THE CHOICES          5 load-bearing decisions, each with criterion + cost
04 ── THE SCALE STORY      what breaks first at 10x users / 100x data / 10x latency
05 ── THE FAILURE STORY    rate limits, token revocation, malformed LLM output, …
06 ── THE HARD PARTS       hardest bug, proudest part, weakest spot
07 ── THE COUNTERFACTUALS  the 4 decisions you'd reconsider, with triggers
08 ── THE AI QUESTION      "did you use AI?" — own the boundary, three modes
```

**01 — The pitch.** Your project in three lengths. The ten-second version is the hardest. Ends the 90-second version on a tradeoff you'd own — the single highest-signal pitch move. *Covers: "what did you build?", "tell me more", "walk me through a project."*

**02 — The architecture.** The system as a labeled diagram you can redraw from memory, the request flow walked top-down, and a map of where interviewers interrupt with the one-liner for each. *Covers: "walk me through the system", "how does the loop stop?", "why four agents?".*

**03 — The choices.** One defense per load-bearing choice — Next.js, the own-agent-loop-over-a-framework call, the sonnet/haiku model split, NDJSON-over-SSE, and no-database. Each names a criterion and a cost. *Covers: "why X not Y?" for every real decision.*

**04 — The scale story.** Three scenarios — 10x users, 100x data, 10x latency-sensitive — with the first bottleneck, the second, and what you'd add when. Honest about the horizontal-scale gap you haven't built. *Covers: "what breaks first at scale?".*

**05 — The failure story.** The real failure surfaces — MCP rate limits, mid-session token revocation, auth-before-stream, the pre-stream setup throw, malformed LLM output, empty data windows — and what the system does in each. *Covers: "what happens when things go wrong?".*

**06 — The hard parts.** The StrictMode double-fetch bug, the production-only 500, the proudest surface (reasoning streamed live), and the part you defend least confidently (MCP/OAuth internals). Answering honestly without collapsing. *Covers: "hardest bug?", "proudest of?", "least confident defending?".*

**07 — The counterfactuals.** The four most reconsiderable decisions — no-DB, demo-replay-as-reliability, fixed spacing, exact-name coverage deps — each with the AI-decision mode and the trigger that would flip it. Plus what you would *not* change, to avoid manufactured regret. *Covers: "what would you do differently?".*

**08 — The AI question.** "Did you use AI?" Yes — and the answer is locating the boundary between deliberate, evaluated-and-accepted, and defaulted-to decisions. The three real bugs you caught the machine on. *Covers: "did you use AI?", "explain this line by line", "what did AI get wrong?".*

## How this connects to the rest of the study system

This book is the **wide opener** — it prepares you for the project-level questions that open an interview. When the interviewer stops asking about the project and drills into *one pattern* — the provider abstraction, the TTL cache, the schema-gated coverage — that's the **deep dive**, and those defenses live in the per-concept Interview-defense blocks inside:

```
  .aipe/rehearse-interview-defense/  ← THIS book — the whole project, wide
  .aipe/study-system-design-dsa/     ← per-concept deep dives (request flow,
                                        caching, streaming, the coverage gate, …)
                                        each concept file has its own Interview
                                        defense block
```

Use both. This book gets you through the first fifteen minutes without rambling; the concept files get you through the follow-up that goes three layers down on a single decision. The reader who studies only this book sounds fluent and folds on the first deep follow-up; the reader who studies only the concept files freezes on "walk me through your project." Pair them.

```
┃ This book is the wide opener. The concept files are the
┃ deep dives. An interview needs both.
```

---
Updated: 2026-05-29 — created
Updated: 2026-05-31 — Migrated to /aipe:rehearse orchestrator (v1.50): directory renamed from .aipe/study-interview-defense/ to .aipe/rehearse-interview-defense/ per spec rename study-interview-defense.md → rehearse-interview-defense.md; cross-references updated. Content unchanged.
