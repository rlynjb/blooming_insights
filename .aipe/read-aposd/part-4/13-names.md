# Chapter 13 — Choosing names

## Opener

Chapter 12 said good comments add precision the code can't carry. Names *are* part of the code, and a precise name carries some of the work a comment would otherwise have to do. A vague name leaves all of it for the comments — or for the reader to figure out.

## The idea

**A name should form a clear image in the reader's head of what the thing is or does — precisely.** Names should be **precise** (the reader knows what's in it and what isn't) and **consistent** (the same concept gets the same word across the codebase, and different concepts get different words). Vague names are where bugs hide, because every reader builds a slightly different mental model from the same word.

## How it works

The blast radius of a vague name compared to a precise one:

```
  A vague name's blast radius vs a precise name's

  ┌─ VAGUE NAME — "data" ────────────────────────────────────────────┐
  │                                                                   │
  │   function process(data) { ... }                                  │
  │                                                                   │
  │   reader has to ask:                                              │
  │      - is `data` raw bytes? a parsed object? a list of records?   │
  │      - what's its shape? does it have any invariants?             │
  │      - is it mutated by process()? returned?                      │
  │      - is null/empty legal?                                       │
  │                                                                   │
  │   ▲                                                               │
  │   │ every caller of process() has to re-answer this from          │
  │   │ context. every reader of the body has to re-answer this       │
  │   │ from inference. the burden is paid at every read site.        │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ PRECISE NAME — "parseAgentJson(text)" ──────────────────────────┐
  │                                                                   │
  │   function parseAgentJson(text: string): unknown { ... }          │
  │                                                                   │
  │   reader can answer from the name alone:                          │
  │      - input is a string                                          │
  │      - it's "agent" output, so probably from an LLM               │
  │      - output is "JSON" (well-known shape category)               │
  │      - the verb is "parse" (read-only, returns a value)           │
  │                                                                   │
  │   ▲                                                               │
  │   │ zero ambiguity at the call site. zero re-derivation needed.   │
  │   │ the type completes the picture; the type guards (chapter 5)   │
  │   │ refine it further at the call site.                           │
  └───────────────────────────────────────────────────────────────────┘
```

The book is precise about what makes a name "good": it produces a *clear image* in the reader's head — neither too narrow (a name that's misleading about what it covers) nor too broad (a name that could apply to anything). "Data" is too broad. `userActiveOrdersAbove50DollarsForCheckout` is too narrow (it's a function name shaped by one caller, chapter-5 special-purpose flag). `orders` plus filters is the right zoom.

A second rule: **consistency matters as much as precision.** If half the codebase says `customerId` and the other half says `userId` for the same concept, every reader pays a small confusion tax. The reverse — different words for different concepts — also matters: if `result` means an MCP tool result in one file and an HTTP response in another, the reader can't reuse vocabulary between modules.

## Why it cuts complexity

Names attack obscurity. A precise name carries the *shape* of what it refers to into every site that uses it; a vague name carries no shape, so the reader has to load it from context every time. Cognitive load drops with precise names — the reader holds the name as a meaningful tag, not a placeholder to dereference. Unknown unknowns drop because an inconsistent vocabulary is exactly the territory where someone says "I thought `result` meant X" and ships a bug. The cause attacked is purely obscurity; structure isn't changing.

Cost: precise names are sometimes *longer*. The book is okay with that — the cost of reading a longer name is paid once per read site; the cost of dereferencing a vague name is paid every time. Long-precise beats short-vague when the name appears more than a few times.

## In your code

`blooming_insights` is mostly good on names; here are three that earn their place, one that's vague, and one inconsistency.

**Earns its place — `parseAgentJson`.** The name says: it parses, it takes an agent's output, it produces JSON-shaped data. The type signature (`(text: string) => unknown`) completes the picture. A reader hits the call site, gets the shape from the name and type alone, and doesn't need to open the body. That's the chapter's goal achieved in one identifier.

**Earns its place — `synthesisInstruction`.** In `lib/agents/base.ts:61` and downstream. The word "synthesis" is precise: it's the instruction the model gets *during the synthesis turn* (the final, forced answer turn), not the system prompt or the per-turn instructions. A vague name like `extraPrompt` would leave the reader guessing when it applies. The precise name carries the *when* into every call site.

**Earns its place — `forceFinal`.** In `lib/agents/base.ts:91`. Says exactly what it is: the boolean that forces the loop into producing a final (non-tool) answer this turn. Compare to alternatives: `noTools` (negative, less clear), `lastTurn` (true but misses the *why*), `terminal` (overloaded with TCP / state-machine connotations). `forceFinal` carries the verb (force) and the goal (final answer) in one word.

**Vague — `data`.** Search the codebase for `data` as a variable name. It appears in test fixtures, in mock objects, and in a few utility paths. Each occurrence is fine in context — but each occurrence also requires the reader to derive the shape from context. The good rename in each case is the *thing* it represents: `briefingFixture`, `mockAnomaly`, `eqlResultSample`. None of those are much longer than `data`, and all of them carry the shape into the read site.

**An inconsistency to watch — `project_id` vs `projectId`.** The MCP tool arguments use `project_id` (snake_case, matching the server's wire format); the TypeScript objects use `projectId` (camelCase, matching JS conventions). The codebase is consistent inside each layer (wire format = snake; in-process = camel) and the two forms only appear at the seam. That's fine — but it's the kind of inconsistency that would become *bad* if `project_id` started appearing inside the TypeScript layer or `projectId` started leaking into the MCP args. The chapter-15 (consistency) lesson will sharpen this — the rule is "same concept, same word *within a layer*," not "same word everywhere."

## The red flag

**Generic names: `data`, `obj`, `tmp`, `manager`, `info`, `result` (when there's no context disambiguating it).** All of these signal that the author didn't pick a name — they picked a placeholder and moved on. The fix is naming the *thing*: not `data`, but `anomalies` or `eqlPayload` or `customerSegments` — whatever is in the variable, by its concept. Related red flag: **`manager` / `helper` / `util` / `processor` suffixes** — these don't tell you what the class does; they tell you the author couldn't think of a more specific word.

## Carry forward

Chapter 13 made the *interface side* of names precise. Chapter 14 turns the table: write the interface comment (the contract) *before* the code. Doing so often reveals that the interface you were about to ship is the wrong one — while it's still cheap to change.

**See also:**
- `lib/agents/base.ts:61` and `:91` — precise names worth studying.
- `audits/cleanup-2026-06-02.md` finding #1 — the `insights` Map has a *precise enough* name (`insights`) but a missing comment about its scope; precision in names doesn't eliminate the need for invariant comments (chapter 12).
