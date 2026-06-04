# Chapter 7 — Pull complexity downward

## Opener

Chapter 6 said each layer must earn its place. This chapter says: when a layer *does* earn its place, the work it does should err on the side of absorbing complexity, not pushing it up.

## The idea

**When you have a choice between making a module's body more complex or making its callers more complex, push the complexity into the body.** One implementer suffers so that N users don't. The module is the right place to absorb a quirky default, a tricky edge case, a configuration choice the module has enough information to make on its own — anything the caller would otherwise have to learn.

This is the most counterintuitive of the deep-module principles, and the easiest to get wrong, because the natural instinct is the opposite: "let the caller decide." Most of the time the caller shouldn't have to.

## How it works

The same total work, two places it can live.

```
  Pull-down vs push-up — where complexity lives

  ┌─ PULL COMPLEXITY DOWN (good) ────────────────────────────────────┐
  │                                                                   │
  │   caller A ──┐                                                    │
  │   caller B ──┤                                                    │
  │   caller C ──┼──► one body that absorbs the work                  │
  │   caller D ──┤        │                                           │
  │   caller E ──┘        │                                           │
  │                       ▼                                           │
  │              fences, retries, defaults, edge cases all here       │
  │              callers stay one line each                           │
  │                                                                   │
  │   total cost: ~ 1 × body complexity                               │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ PUSH COMPLEXITY UP (bad) ───────────────────────────────────────┐
  │                                                                   │
  │   caller A ──► [knob 1] [knob 2] [retry] [fence?] → tiny body     │
  │   caller B ──► [knob 1] [knob 2] [retry] [fence?] → tiny body     │
  │   caller C ──► [knob 1] [knob 2] [retry] [fence?] → tiny body     │
  │   caller D ──► [knob 1] [knob 2] [retry] [fence?] → tiny body     │
  │   caller E ──► [knob 1] [knob 2] [retry] [fence?] → tiny body     │
  │                                                                   │
  │   total cost: ~ 5 × caller complexity                             │
  └───────────────────────────────────────────────────────────────────┘
```

The picture multiplies a small per-caller cost by however many callers there are. With one caller, both shapes cost about the same. With five callers, the push-up shape costs five times as much in code, five times as much in reading effort, and five times as many places a bug can hide. The pull-down shape costs the same as it did with one caller — the body absorbs the work once.

The principle has a caller-side mirror: **don't expose config that the module had enough information to decide.** If `callTool(name, args, { retryDelayMs?, retryCeilingMs?, cacheTtlMs? })` ships with seven optional knobs, the burden of choosing falls on every caller. If `callTool(name, args)` picks sensible defaults internally and you only override them where there's a real reason, the burden lives in one body.

## Why it cuts complexity

This is the principle that turns chapter 3's "deep module" into a *deepening* practice across time. Every decision the module absorbs is one fewer decision the caller has to repeat. Cognitive load goes down at every call site; change amplification goes to zero (changing the default doesn't change call sites that took the default); unknown unknowns drop because the body's behavior is one place, knowable, testable. The cause it attacks is *both* dependency (callers don't depend on knobs they don't need) and obscurity (the decision is named once, in the body, with a comment if necessary).

The cost the book wants you to accept: the body is harder to maintain than the body of a shallow module. That cost is real and the trade is asymmetric — one engineer's harder body for N callers' easier sites. That asymmetry is the principle's leverage.

## In your code

The running example continues to earn its rent.

**Pull-down in `parseAgentJson`.** Five LLM quirks (fenced output, optional language tag, whitespace, prose around JSON, truncated outputs) all live inside the eleven-line body at `lib/mcp/validate.ts:3-13`. Four agent files (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`) each contain *exactly* this:

```
  try {
    parsed = parseAgentJson(finalText);
  } catch {
    return [];
  }
```

That's the pull-down. Five quirks in one body. Four callers stayed one line each.

Imagine the push-up alternative. Each caller would have to know:
- to look for a ` ```json ` fence first;
- that the fence might or might not include the `json` tag;
- that the model sometimes wraps prose around the JSON;
- to fall back to the outermost-bracket substring scan;
- that fences sometimes open and never close.

Five facts × four callers = twenty places those facts could be wrong, twenty places a future LLM behavior change would have to be fixed. The pull-down made them five facts × one place. The change amplification benefit is the entire point of this chapter.

**Pull-down in `McpClient`.** `lib/mcp/client.ts:88-95` makes four policy decisions in its constructor: `minIntervalMs = 200` (1 req/s pacing), `maxRetries = 3` (the budget cap), `retryDelayMs = 10_000` (the observed Bloomreach window), `retryCeilingMs = 20_000`. Every agent that calls `mcp.callTool(name, args)` gets all four policies for free without picking them. The defaults are named in the constructor with a comment explaining the 10s window comes from Bloomreach's observed behavior — that's pull-down done right, including the *reason* for the default sitting next to the default.

**A push-up that crept in — the four agents' `synthesisInstruction`.** Each agent passes `synthesisInstruction` into `runAgentLoop` (`monitoring.ts:103`, `diagnostic.ts`, `recommendation.ts`, `query.ts`). The strings are similar but not identical: "Output ONLY a JSON array …" / "Output ONLY a Diagnosis JSON object …" / etc. The forced-final-turn shape is a policy that `runAgentLoop` could plausibly absorb (it already has `forceFinal` logic), but currently it's a string each caller picks. The lesson isn't "this is wrong" — there's a reasonable case that the per-agent shape is *exactly* the caller's concern. The lesson is to ask the question: is this knob there because the body genuinely doesn't have enough information to decide, or because we pushed it up by reflex? `.aipe/study-software-design/04-synthesize-recovery-duplication.md` walks this pattern as a small duplication finding.

## The red flag

**A config knob the module had enough information to decide itself.** If the module exposes `retryDelayMs?` as an optional parameter but ships with a hardcoded sensible default that 100% of callers use, the knob is decoration — push the decision into the body, document why, and leave the override path only if there's a real overriding caller. Related: **boolean parameter that flips a behavior the module could detect from its inputs.** `parse(text, { fenced: true })` is a push-up; `parse(text)` with the body detecting the fence is pull-down.

## Carry forward

Chapter 7 said pull complexity into one body. Chapter 8 takes the symmetric question: when is one body actually two? When should you split? The book's answer is the opposite of the usual instinct: combine more often than you split.

**See also:**
- `lib/mcp/validate.ts:3-13` — the running example, this chapter's clearest case.
- `lib/mcp/client.ts:88-95` — defaults named with their reason.
- `.aipe/study-software-design/04-synthesize-recovery-duplication.md` — the `synthesisInstruction` duplication.
