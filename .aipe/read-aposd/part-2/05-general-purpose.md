# Chapter 5 — General-purpose is deeper

## Opener

Chapter 4 said interfaces hide decisions. This chapter is about how to *shape* the interface. Ousterhout's claim is counterintuitive: aim slightly more general than today's caller demands, and the module gets simpler at the same time.

## The idea

**Make your modules somewhat general-purpose.** Shape the interface around the underlying problem the module solves, not around the specific way one current caller wants to use it. A somewhat-general interface is usually *both* simpler *and* more reusable than a special-purpose one — because the special-purpose version is forced to expose the caller's specific assumptions, and the general version doesn't.

The word "somewhat" is doing real work. The book is not arguing for fully-general abstract framework code that no one needs yet. It's arguing against the trap of shaping `getUserActiveOrdersForCheckoutPageBelow$50()` when `getOrders(filter)` is the cleaner interface and not noticeably more code to write.

## How it works

Look at the same module shaped two ways.

```
  Special-purpose vs general-purpose — the interface shape

  ┌─ SPECIAL-PURPOSE ────────────────────────────────────────────────┐
  │                                                                   │
  │   caller A ──► parseAnomalyJson(text)   → Anomaly[]               │
  │   caller B ──► parseDiagnosisJson(text) → Diagnosis               │
  │   caller C ──► parseRecsJson(text)      → Recommendation[]        │
  │   caller D ──► parseQueryJson(text)     → string                  │
  │                                                                   │
  │     ▲                                                             │
  │     │  each method exists for exactly ONE caller                  │
  │     │  each duplicates the fence/scan/JSON.parse logic            │
  │     │  the interface mirrors today's single use case              │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ GENERAL-PURPOSE ────────────────────────────────────────────────┐
  │                                                                   │
  │   caller A ──┐                                                    │
  │   caller B ──┤                                                    │
  │   caller C ──┼──► parseAgentJson(text) → unknown                  │
  │   caller D ──┘            │                                       │
  │                            ▼                                       │
  │                  caller narrows via type guard:                   │
  │                  isAnomalyArray() / isDiagnosis() / …             │
  │                                                                   │
  │     ▲                                                             │
  │     │  ONE method serves all four callers                         │
  │     │  zero duplication of the parse logic                        │
  │     │  the interface is shaped by the problem                    │
  │     │  (turn LLM text into structured data), not by the user      │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

The general version is **deeper** in the chapter-3 sense (smaller interface, same body), **and** simpler (one signature instead of four). That's the unintuitive part: you didn't trade simplicity for reusability; you got both.

The trick the second shape uses is **two-step typing**: the parse is generic (returns `unknown`), and the narrowing is per-caller (via type guards). That split puts the *general* concern (parsing) in one module and the *specific* concern (this caller's shape) at the call site, where it belongs. Each side stays simple.

## Why it cuts complexity

The special-purpose version multiplies dependencies. Four callers now depend on four functions, each of which has its own copy of the fence/scan/parse logic. If the LLM emits a new format, four files need to learn the new quirk. The general-purpose version has one body, one dependency surface, one place to fix; change amplification drops to zero for parsing changes. The cause it removes is *dependency proliferation* — the special-purpose interface pretends each caller is independent, but they're all really doing the same job, so making them share is honest about what's actually going on.

There's one cost worth naming. A general-purpose interface forces callers to do a small amount of work at the call site (the type-narrowing). The book argues that's fine and usually correct: the caller is the one place that *should* know what shape it expects back. Pushing that knowledge into the parser is what made the special-purpose version shallow.

## In your code

The running example is the textbook win for this principle.

**The interface — general:**

```
  parseAgentJson(text: string): unknown
```

The return type is `unknown`. Not `Anomaly[]`. Not `Diagnosis`. Not `Recommendation[]`. Not `string`. The module knows it's parsing JSON; it does *not* know what the JSON should mean. That's a deliberate "somewhat general."

**The narrowing — per caller, at the call site:**

In `lib/mcp/validate.ts:17-27` you'll find `isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`. Each is a type guard the caller composes with `parseAgentJson` to get the typed shape it needed. The monitoring agent does:

```
  parsed = parseAgentJson(finalText);
  if (!isAnomalyArray(parsed)) return [];
  return [...parsed].sort(...).slice(0, 10);
```

Two steps. One general parse. One specific guard. The general step is shared; the specific step is local. Each caller gets exactly what it needs and the parse logic doesn't fork.

**Resist the temptation to specialize.** Someone reading the monitoring code might want to write a wrapper that does both steps:

```
  // tempting, do not write
  function parseMonitoringJson(text: string): Anomaly[] | null { ... }
```

That wrapper is shallower (it adds nothing the call site couldn't compose), it duplicates the fallback shape (`null` vs `[]`), and it only exists for one caller. The book's "method that exists for exactly one call site" red flag would fire on it immediately. The general version, kept general, is correct.

**Where this repo *does* specialize, intentionally.** `schemaSummary(schema)` in `lib/agents/monitoring.ts:16-49` is special-purpose: it knows exactly the format the monitoring prompt needs, with the specific event/property caps for that prompt. It's *correct* to be special-purpose here, because the format is owned by one prompt template. The general version ("summarize a schema for any prompt") would have no information to use to decide what to keep — it'd need configuration that effectively recreates the special-purpose version. The book's word "somewhat" covers this: general where general is shared work, specific where specific is local concern.

## The red flag

**A method that exists for exactly one call site, mirroring that call site's shape.** If you have `getUserActiveOrdersAbove$50ForCheckout(uid)` instead of `getOrders(uid, filter)`, the first one was shaped by the caller's vocabulary, not the underlying problem. Two cheap tests: (1) could you give this method a name without naming the caller? If not, it's too special. (2) Does the method's signature mention concepts the caller could compose itself? If yes, push the composition back out.

## Carry forward

Deep modules with general-purpose interfaces tell you how to *shape* one module. Chapter 6 zooms out one level: how should *adjacent* modules differ from each other? The answer is "each layer in the stack should offer a different abstraction" — or it's not earning its place.

**See also:**
- `lib/mcp/validate.ts:3-13` — the general parser.
- `lib/mcp/validate.ts:17-27` — the per-caller type guards that pair with it.
- `.aipe/study-dsa-foundations/` — `parseAgentJson` walked from the parsing-patterns angle.
