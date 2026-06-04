# Chapter 4 — Information hiding (and leakage)

## Opener

Chapter 3 said a deep module hides a lot behind a small interface. This chapter asks the sharper question: hides *what*, exactly? And what does it look like when the hiding *fails*?

## The idea

**Each module should hide one or more design decisions behind its interface, so changing the decision changes one place.** When the same decision is encoded in two modules, both have to change together — that's **information leakage**, and it's the single biggest source of change amplification in working systems.

The deep-module shape from chapter 3 is the *shell*; information hiding is what makes the shell worth having.

## How it works

A design decision lives in exactly one of two places. Either it's sealed inside a module's body (only that module knows), or it's bleeding across multiple modules (they each have to know). Picture the contrast.

```
  A decision sealed vs a decision leaking

  ┌─ SEALED — decision lives in one body ────────────────────────────┐
  │                                                                   │
  │   caller ──────────► ┌─ module A ─────────────────────────┐       │
  │  "do the thing"      │                                    │       │
  │                      │   knows: how the thing is encoded, │       │
  │                      │          which retry hint to read, │       │
  │                      │          which envelope to unwrap  │       │
  │                      │                                    │       │
  │                      └────────────────────────────────────┘       │
  │                                                                   │
  │   net: change the encoding → edit ONE file                        │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ LEAKING — decision lives in N bodies ───────────────────────────┐
  │                                                                   │
  │   caller A ──► ┌─ module 1 ─┐                                     │
  │                │  knows the │  ← both modules must agree on the   │
  │                │  encoding  │    same encoding decision. neither  │
  │                └────────────┘    OWNS it; both DEPEND on it.      │
  │                                                                   │
  │   caller B ──► ┌─ module 2 ─┐                                     │
  │                │  knows the │  ← change the encoding → edit BOTH  │
  │                │  encoding  │    (and the test that mocks it)     │
  │                └────────────┘                                     │
  │                                                                   │
  │   net: a fact about the world is duplicated; the modules look     │
  │   independent and aren't.                                         │
  └───────────────────────────────────────────────────────────────────┘
```

The leak in the second picture isn't always a duplicated *value* — often it's a duplicated *assumption*. Module 1 assumes the wire format has a `result.content[0].text` shape; module 2 also has to know that, because module 1's output didn't unwrap it. That's a leak of one decision (how Bloomreach envelopes look) across what should have been one module's territory.

There's also a related anti-pattern the book names explicitly: **temporal decomposition**, where modules are split by *the order things happen in time* rather than by *what decision each owns*. `parsePhase`, `validatePhase`, `transformPhase` — three files that each know the same shape of data because they're handing it off in sequence, none of them really hiding anything. The result is the same as leakage: the shared knowledge is everywhere.

## Why it cuts complexity

Sealing a decision attacks dependencies at the root. A fact that lives in one body has no external dependents — only the body's interface does. A fact that lives in N bodies creates N(N-1)/2 implicit "we must agree on this" edges between them, none of which are visible in the code; they only surface as bugs when one module updates and the others don't. That last sentence is the definition of **unknown unknowns** from chapter 1 — the third and worst symptom of complexity. Information hiding is the most direct way to eliminate it: if there's only one place that knows, there's no other place that can silently disagree.

## In your code

Three quick reads from `blooming_insights` — one good seal, one leak that exists, one leak the codebase actively prevented.

**Sealed cleanly — `parseAgentJson` hides "what does Claude's output look like."** Callers do `parseAgentJson(text)` and get back `unknown`. They don't know about fences. They don't know about prose. They don't know about the substring scan. If a future model starts emitting JSON wrapped in `<json>…</json>` XML tags instead of triple-backticks, you add quirk #6 to `lib/mcp/validate.ts:3-13` and ship. The four agent files don't change. *That* is what information hiding buys.

**Leaking subtly — the `Insight` vs `Anomaly` shape duplication.** `lib/mcp/types.ts` defines `Insight` and `Anomaly` as separate types that share most fields (`metric`, `scope`, `change`, `severity`, `evidence?`, `impact?`). The "this is the same thing in two contexts" decision is implicit; nothing in code says `Insight` is `Anomaly` with extra UI fields. The result is that adding a field like `category` requires editing both shapes plus the validator. This is documented in `.aipe/study-software-design/03-insight-anomaly-silent-leak.md` as a known leak in this repo. The fix shape (a base type plus an extension) would re-seal the decision.

**Almost leaked, then sealed — the MCP envelope shape.** The Bloomreach MCP server returns results in two possible shapes: a `structuredContent` field (preferred) or `content[0].text` (fallback). Early in this repo's life that knowledge lived inside multiple call sites. Now it lives inside `McpClient.callTool` in `lib/mcp/client.ts` and the transport layer, and callers see a uniform `{ result, durationMs, fromCache }` no matter which envelope the server returned. The fact that the server has two envelope shapes is fully sealed. The project context (`AGENTS.md`) calls this out as load-bearing: "The MCP result envelope handling (prefer `structuredContent`, else `content[0].text`)" is something that *must not change* exactly because it's now sealed in one place and the seal is the contract.

## The red flag

**Information leakage.** Spot it by asking *if I changed this decision, how many files would I have to edit?* If the answer is more than one for a *single* decision (not a single feature touching multiple decisions — those are different things), you have a leak. The book also calls out **temporal decomposition** as the most common form of accidental leakage: when files split by `phase 1 / phase 2 / phase 3` instead of by `this hides decision X / this hides decision Y`, the same fact shows up in all three phases by definition.

## Carry forward

Information hiding tells you *what* to put inside the body. Chapter 5 takes the next step: what should the *interface* look like? The answer Ousterhout argues is non-obvious — make it slightly *more* general-purpose than today's caller needs, and the module gets deeper.

**See also:**
- `.aipe/study-software-design/03-insight-anomaly-silent-leak.md` — the `Insight`/`Anomaly` leak walked in detail.
- `.aipe/study-software-design/01-mcp-client-deep-module.md` — the MCP envelope seal.
