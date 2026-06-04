# Chapter 3 — Deep modules

## Opener

Chapter 2 said the strategic investment is 10-20% per change. This chapter tells you *what* to spend it on. The highest-leverage move in the book is here.

## The idea

**A module's value is the functionality it provides divided by the size of its interface.** A **deep module** does a lot behind a small interface. A **shallow module** has an interface nearly as complex as the work it does — so it forces every caller to re-learn what the module already knows, which gives you all the cost of a module and none of the benefit.

The best modules in any codebase are the deepest ones. The worst are not the buggy ones; they're the *shallow* ones, because the buggy ones can be fixed and the shallow ones can only be re-designed.

## How it works

Picture two modules of equal functionality and compare what the caller sees.

```
  Deep vs shallow — the value ratio is the shape

  ┌────────────────────────────┐         ┌───────────────────────────┐
  │   DEEP MODULE              │         │   SHALLOW MODULE          │
  │                            │         │                           │
  │   ┌──────────────────┐     │         │   ┌─────────────────────┐ │
  │   │  interface       │     │         │   │  interface          │ │
  │   │  one function,   │     │         │   │  N functions, each  │ │
  │   │  one input,      │     │         │   │  with M options,    │ │
  │   │  one output      │     │         │   │  caller picks       │ │
  │   └────────┬─────────┘     │         │   └─────────┬───────────┘ │
  │            │  (small —     │         │             │  (almost as │
  │            │   the caller  │         │             │   big as    │
  │            │   only sees   │         │             │   the body) │
  │            │   this)       │         │             │             │
  │   ┌────────▼─────────────┐ │         │   ┌─────────▼───────────┐ │
  │   │  body                │ │         │   │  body                │ │
  │   │  handles 5 quirks    │ │         │   │  thin wrapper around │ │
  │   │  branches            │ │         │   │  what the caller     │ │
  │   │  edge cases          │ │         │   │  already had to know │ │
  │   │  fallbacks           │ │         │   │                      │ │
  │   │                      │ │         │   └──────────────────────┘ │
  │   └──────────────────────┘ │         │                            │
  │                            │         │   net cost: caller learns  │
  │   net win: caller writes   │         │   the surface AND the      │
  │   one line; gets all the   │         │   body. Module added no    │
  │   handling for free        │         │   abstraction.             │
  └────────────────────────────┘         └────────────────────────────┘
```

The shape on the left is what you want everywhere. The shape on the right is the classic problem: an engineer felt they "broke up the code into a module" and counts that as design work, but the interface didn't actually hide anything. The caller now has to read both the surface and the body to use it safely, which means the module made things *worse*.

## Why it cuts complexity

Deep modules attack both causes at once. A small interface reduces *dependencies* — the caller binds to a minimal contract, so changes inside the body don't cascade outward. A meaningful body that hides decisions reduces *obscurity* — the caller doesn't have to know about fences, retries, error envelopes, units; those facts live in one place. Every one of the three symptoms goes down: change amplification (you edit the body, not the call sites), cognitive load (the caller holds one signature, not five), unknown unknowns (the body owns the surprises, so callers can't trip them).

The deeper-better trade has one cost worth naming: the body of a deep module is harder to maintain than the body of a shallow one, because it does more. That's the **deliberate trade** the book is asking you to make. One engineer suffers in the deep body so that ten callers don't suffer at the call sites. That's a good trade in any realistic codebase.

## In your code — `parseAgentJson` is the textbook deep module

The running example is so on-the-nose for this chapter that we can use it as the worked case.

**The interface — one line:**

```
  function parseAgentJson(text: string): unknown
```

That's the full surface the caller sees. One argument: a string. One return: `unknown` (callers narrow it via a type guard).

**The body — eleven lines absorbing five LLM quirks**, at `lib/mcp/validate.ts:3-13`:

```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);   // quirk 1
  const candidate = (fence ? fence[1] : text).trim();          // quirk 2
  try { return JSON.parse(candidate); } catch { /* … */ }      // quirk 3
  const start = candidate.search(/[[{]/);                      // quirk 4
  const end = Math.max(candidate.lastIndexOf(']'),
                       candidate.lastIndexOf('}'));            //   "
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));        // quirk 5
  }
  throw new Error('no parseable json in agent output');
```

The five quirks each came from production:

1. **Fenced JSON.** Claude wraps almost every JSON answer in a ` ```json ` fence. The naive `JSON.parse(text)` throws on the backticks.
2. **Whitespace and the optional language tag.** The fence might be ` ```json `, ` ``` `, or `\n```\n`. The regex absorbs all three.
3. **Clean parse path.** When the fence captured cleanly, `JSON.parse` works first try. We don't burn the substring scan if we don't need it.
4. **Prose around the JSON.** When the model emits "Here is the array: `[{...}]` — let me know if you need anything else," `JSON.parse` chokes on the prose. We scan for the outermost `[` or `{` and the last matching closer.
5. **Truncated / partial outputs.** Sometimes the fence opens and never closes (token budget). The outermost-bracket scan still finds a parseable slice when the *brackets* balanced even if the fence didn't.

**The four callers, all one-line.** `monitoring.ts:114`, `diagnostic.ts`, `recommendation.ts`, `query.ts` all do the same thing:

```
  try {
    parsed = parseAgentJson(finalText);
  } catch {
    return [];
  }
```

Each caller binds to the one-line interface and gets all five quirks handled. None of them needs to know what a fence is. None of them duplicates the substring-scan fallback. Add a sixth quirk tomorrow (Claude starts emitting BOMs or Unicode whitespace or zero-width-join inside numbers, whatever) and you edit *one file*, not four.

That's the deep-module win, made concrete: huge functionality, one-line interface, four callers stayed at one line each.

**Cross-reference.** This same function is studied from the DSA-foundations angle in `.aipe/study-dsa-foundations/` as a small parser pattern — but it's a deep-modules case first, because the design lesson outranks the algorithm.

## The negative case — `app/page.tsx` is the textbook shallow monster

The contrast in this repo is sharp. `app/page.tsx` is 817 lines: mode toggle, auth recovery, two-column layout, demo replay routing, dev capture flow, briefing fetch state, error panel, reconnect button, query-box gating. Each of those is a "responsibility" that lives in the same component, exposed to anything else in the same file. The interface to this component is "render the feed page," which is almost the entire body — there's no abstraction. Edit anything inside and you have to re-read most of the file to know what else uses what you touched.

The cleanup audit (`audits/cleanup-2026-06-02.md`) classifies this as `fix-soon`, not `fix-now`, deliberately — it's painful but not actively buggy, and breaking it up during a non-feature cleanup pass is exactly how behaviour-preserving refactors silently become behaviour-changing ones. But it's the canonical shallow-module shape in this repo: huge surface, no information hiding, every reader pays for every responsibility.

## The red flag

**Shallow module.** Spot it by asking: *what does the caller still have to know that the module ought to have absorbed?* If the answer is "most of what's inside it," the module is shallow. A related flag the book names: **classitis** — the discipline-as-decoration habit of breaking a problem into many tiny classes/files because "small files are good," when each tiny class doesn't actually hide anything. Three two-line classes are shallower than one ten-line function.

## Carry forward

Deep modules are the weapon. The next chapter sharpens *what* deep modules hide — design decisions, behind their interface — and what it looks like when that hiding leaks.

**See also:**
- `.aipe/study-software-design/01-mcp-client-deep-module.md` — `McpClient` walked as a deep-module case.
- `.aipe/study-software-design/02-shallow-module-page-component.md` — `app/page.tsx` walked as the shallow contrast.
- `.aipe/study-agent-architecture/03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — "a sub-agent is a tool with a loop inside" is the same shape one level up: huge behaviour behind one call.
- `.aipe/study-dsa-foundations/` — `parseAgentJson` examined as a small parser pattern.
