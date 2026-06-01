# Complexity in this codebase

**Industry name(s):** Cognitive load · accidental complexity · change amplification · unknown-unknowns
**Type:** Industry standard · Language-agnostic (Ousterhout's three symptoms, applied here)

> Complexity is anything that makes a system hard to understand or modify. It shows up in three ways — a change that ripples across many files, a module nobody wants to touch, and questions that don't surface until something breaks. This file finds where each one lives in blooming insights.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Complexity in this codebase concentrates in *one band* — the UI/streaming band, where the feed page (`app/page.tsx`) holds rendering, fetch orchestration, NDJSON parsing, reconnect policy, and demo-capture in a single 817-line client component. Everything below it (agents, MCP wrappers, state) is small and crisp. So the diagnostic isn't "the codebase is complex" — it's "complexity has a postal address," and the address is on the client.

```
Zoom out — where complexity concentrates

┌─ UI layer (Next.js client components) ─────────────────────────┐
│  app/page.tsx  ★ HOTSPOT ★  817 LOC                            │ ← we are here
│   ├─ rendering   ├─ NDJSON stream parsing                      │
│   ├─ feed state  ├─ reconnect policy                           │
│   ├─ mode toggle ├─ demo capture                               │
│   └─ trace items └─ live status line                           │
│  app/investigate/[id]/page.tsx  225 LOC (calmer)               │
│  components/feed/InsightCard.tsx  495 LOC (mostly inline CSS)  │
└──────────────────────────┬─────────────────────────────────────┘
                           │ fetch / NDJSON
┌─ Route layer ────────────▼─────────────────────────────────────┐
│  /api/briefing (266 LOC) · /api/agent (269 LOC)                │
│  smaller, but each carries demo-replay + live in one file      │
└──────────────────────────┬─────────────────────────────────────┘
                           │ Anthropic + MCP
┌─ lib/agents ─────────────▼─────────────────────────────────────┐
│  base.ts (177)   monitoring.ts (122)   diagnostic.ts (128)     │
│  recommendation.ts (134)   categories.ts (161)                 │
│  small, focused, calm — no hotspots                            │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌─ lib/mcp ────────────────▼─────────────────────────────────────┐
│  client.ts (172)   transport.ts (74)   auth.ts (260)           │
│  auth.ts is the densest, but its complexity is intrinsic       │
│  (OAuth + 3 storage backends) not accidental                   │
└────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: where does this codebase actually cost the next contributor time? Not "what does it do" — Ousterhout's question. Three symptoms answer it: **change amplification** (a single decision lives in many places), **cognitive load** (one file holds too many unrelated concerns to fit in working memory), and **unknown-unknowns** (state that exists but isn't visible from any single file). The next sections walk each symptom against the actual files.

---

## Structure pass

**Layers.** Four layers carry this codebase: UI client components → route handlers → agents (Anthropic + MCP loops) → MCP wrapper (cache + transport + auth). The complexity question changes shape at each layer — but the answer concentrates at the top.

**Axis: cognitive load per file.** How many independent concerns does one file ask you to hold in your head before you can edit it safely? This is the right axis because change amplification and unknown-unknowns are downstream of cognitive load — once a file holds too much, the same fact ends up edited in two places (amplification), and side effects hide behind the noise (unknown-unknowns). Trace this single question across the four layers and the seam pops.

**Seams.** Two seams matter. The first is between the **route handler and the UI** — the NDJSON stream contract. It's clean on the route side (`AgentEvent` union in `lib/mcp/events.ts`); it's messy on the UI side (the page component parses it inline). The cognitive load flips there. The second seam is between the **agents and the MCP wrapper** — `McpCaller` (`lib/agents/base.ts` L16–L22). The agent loop knows nothing about retries, cache TTLs, or spacing; the wrapper knows nothing about prompts or tool subsets. The cognitive load *doesn't* flip there — both sides are small. That's the load-bearing contrast: the seam that works (agent → MCP) vs the one that doesn't (route → UI).

```
Structure pass — where cognitive load spikes

┌─ 1. LAYERS ─────────────────────────────────────────────┐
│  UI client · Route handler · Agent loop · MCP wrapper    │
└────────────────────────────┬─────────────────────────────┘
                             │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  cognitive load: how many concerns per file?              │
└────────────────────────────┬─────────────────────────────┘
                             │  trace across layers, find flips
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  S1: Route → UI ★load-bearing                             │
│      (clean event union → page component drowns in it)    │
│  S2: Agent → MCP wrapper (clean both sides — praise)      │
└────────────────────────────┬─────────────────────────────┘
                             ▼
                     Block 4 — How it works
```

---

## How it works

### Move 1 — the three symptoms

Ousterhout names three symptoms of complexity, and the diagnostic move is to look for each one separately. You know how a slow page-load could be the server, the network, OR the render — you don't fix it by saying "it's slow," you fix it by asking which layer is slow. Same here: "this code is complex" tells you nothing; *which symptom is firing* tells you what to do.

```
The three symptoms of complexity

  ┌──────────────────────────┐
  │ 1. CHANGE AMPLIFICATION  │  one decision lives in many places
  │    "I changed X in       │  edit one, the others drift
  │     three files today"   │
  └──────────────────────────┘
  ┌──────────────────────────┐
  │ 2. COGNITIVE LOAD        │  one place holds too much unrelated stuff
  │    "I avoid opening      │  no one wants to touch it
  │     that file"           │
  └──────────────────────────┘
  ┌──────────────────────────┐
  │ 3. UNKNOWN-UNKNOWNS      │  facts you'd need to know to be safe
  │    "I didn't know that   │  aren't visible from where you're editing
  │     existed"             │
  └──────────────────────────┘
```

### Move 2 — symptom 1: change amplification

**What it is.** A single fact ("how do you convert an Insight to an Anomaly?", "what's the synthesis prompt for tool-less recovery?") is encoded in two or more files. Edit one and the others drift.

```
Change amplification — same knowledge, two locations

  file A                            file B
  ┌──────────────────┐              ┌──────────────────┐
  │ insightToAnomaly │  same logic  │ anomalyToInsight │
  │ (server route)   │ ◄──────────► │ (state module)   │
  └──────────────────┘              └──────────────────┘
       edit one ─── the other goes stale ─── bug
```

In this codebase: the round-trip between `Insight` and `Anomaly` lives in two files. There's also a softer version: the `synthesize` recovery method (run the model tool-less when it won't emit JSON) lives in both `diagnostic.ts` and `recommendation.ts` — two copies of the same shape. See Block 6 for the exact locations.

### Move 2 — symptom 2: cognitive load

**What it is.** One file holds so many independent concerns that no single reader can hold them all in working memory. The file becomes the one nobody wants to touch — not because it's bad code line by line, but because picking up *any* edit means swapping six unrelated contexts in.

```
Cognitive load — one file, many concerns

  ┌─ app/page.tsx (817 LOC) ──────────────────────────────┐
  │  1. layout + JSX (the actual UI)                       │
  │  2. NDJSON stream reader loop                          │
  │  3. demo / live mode toggle + persistence              │
  │  4. dev-only demo-capture flow                         │
  │  5. auto-reconnect on revoked token                    │
  │  6. monitoring stepper state derivation                │
  │  7. coverage tile accumulation                         │
  │  8. trace item accumulation                            │
  └────────────────────────────────────────────────────────┘
         ▲
         │  touch ANY of these and you have to scan past
         │  the other seven first
```

This is the single biggest cognitive-load hotspot in the repo. See Block 6.

### Move 2 — symptom 3: unknown-unknowns

**What it is.** Side effects, shared state, or implicit ordering that you'd need to know about to edit safely — but that nothing in the file you're editing points at. The "I didn't know that existed" bug.

```
Unknown-unknowns — invisible state

  file you're editing            invisible coupling
  ┌────────────────────┐         ┌──────────────────────────┐
  │ change a field on  │ ───X──► │ another file reads that  │
  │ AgentEvent.diagnose│         │ field via type-narrowed  │
  └────────────────────┘         │ filter (filterByStep)    │
                                  └──────────────────────────┘
       no compile error, no test failure, just a runtime gap
```

In this codebase: `filterByStep` in `app/api/agent/route.ts` (L66–L84) inspects `AgentEvent` shapes by tag *and* by an `agent` property nested inside two specific variants. Add a new event type to `lib/mcp/events.ts` and the filter silently drops it from the demo replay. Nothing in `events.ts` points at the filter. The state module's `_clear` test-helper is similar — three Maps it has to remember to clear, and forgetting one leaks insights across test runs.

### Move 3 — the principle

You don't fix complexity by being smarter; you fix it by *naming which symptom is firing* and going at that one. The page component isn't "complex" — it has a cognitive-load problem. The `insightToAnomaly` duplication isn't "messy" — it's change amplification. The `filterByStep` filter isn't "fragile" — it's an unknown-unknown waiting to fire. Three different fixes, three different names. The win is the diagnostic vocabulary, not a generic call to "refactor."

---

## Primary diagram

The whole audit, ranked by symptom and located in the codebase:

```
Complexity hotspots — by symptom, by file

  ┌─ Change amplification ──────────────────────────────────────────┐
  │  Anomaly ↔ Insight mapping                                       │
  │    app/api/agent/route.ts          L29–L31  (insightToAnomaly)   │
  │    lib/state/insights.ts           L8–L28   (anomalyToInsight)   │
  │                                                                  │
  │  Tool-less synthesis recovery                                    │
  │    lib/agents/diagnostic.ts        L86–L126 (synthesize)         │
  │    lib/agents/recommendation.ts    L82–L132 (synthesize)         │
  └──────────────────────────────────────────────────────────────────┘
  ┌─ Cognitive load ────────────────────────────────────────────────┐
  │  app/page.tsx                       817 LOC, ~8 concerns         │  ★ #1 hotspot
  │  lib/hooks/useInvestigation.ts      216 LOC (NDJSON in a hook)   │
  │  components/feed/InsightCard.tsx    495 LOC (inline-CSS-heavy)   │
  └──────────────────────────────────────────────────────────────────┘
  ┌─ Unknown-unknowns ──────────────────────────────────────────────┐
  │  filterByStep                                                    │
  │    app/api/agent/route.ts          L66–L84 (depends on shapes    │
  │                                              defined elsewhere)  │
  │  state Maps `_clear` test helper                                 │
  │    lib/state/insights.ts           L64–L68 (3 maps must align)   │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Three places where the symptoms actually bite, picked because each one is a real maintenance moment a next contributor will hit.

### 1. Change amplification — the Insight ↔ Anomaly mapping

The codebase converts both ways between `Anomaly` (what the monitoring agent emits) and `Insight` (what the feed renders). The two mappings sit in different files.

```
lib/state/insights.ts  (lines 8–28)

  export function anomalyToInsight(a: Anomaly): Insight {
    const id = crypto.randomUUID();             ← assigns the id
    const sign = a.change.direction === 'down' ? '-' : '+';
    const headline = `${a.scope.join(' ')} ${a.metric} · ${sign}${Math.abs(a.change.value)}%`...
    return {
      id,
      timestamp: new Date().toISOString(),
      severity: a.severity,
      headline,                                  ← derived
      summary: ...,                              ← derived
      metric: a.metric,                          ← copied
      change: a.change,                          ← copied
      scope: a.scope,                            ← copied
      source: 'monitoring',                      ← stamped
      evidence: a.evidence,                      ← copied
      impact: a.impact,                          ← copied
      history: a.history,                        ← copied
      category: a.category,                      ← copied
      ...deriveInsightFields(a),                 ← enriched
    };
  }
       │
       └─ this is "the canonical mapping" — long, derives several fields


app/api/agent/route.ts  (lines 29–31)

  function insightToAnomaly(i: Insight): Anomaly {
    return { metric: i.metric, scope: i.scope, change: i.change, severity: i.severity, evidence: [] };
  }
       │
       └─ same domain, smaller surface — but the field LIST has to stay
          in sync with anomalyToInsight. Add a new field to Anomaly
          (e.g. `history`) and the round-trip silently drops it.
```

**The fix:** lift `insightToAnomaly` into `lib/state/insights.ts` alongside its inverse, and import. The two mappings have to live next to each other; that's where the round-trip invariant becomes visible.

### 2. Cognitive load — `app/page.tsx`

The 817-line file holds eight independent concerns. The NDJSON reader loop alone is 90 lines (L439–L464); the demo-capture flow is 90 lines (L156–L256); the reconnect policy is buried inside the `error` event handler (L400–L432).

```
app/page.tsx — the concern map

  L1–L94    types + small helpers (stashInsights, readBody, formatCustomerCount)
  L95–L150  state declarations (14 useState hooks)
  L156–L256 demo-capture flow (postCapture, runInvestigation, captureAll)
  L258–L476 the big useEffect — fetch + NDJSON read loop + event handlers
  L478–L817 JSX — header, mode toggle, stepper, feed, sidebar, capture button
       │
       └─ touching the JSX requires scrolling past 470 lines of unrelated
          logic; touching the NDJSON loop requires scrolling past 150 lines
          of demo-capture you didn't ask to read. cognitive load is high
          because the concerns are independent — nothing about the demo
          capture flow is needed to understand the stream reader.
```

**The fix (sketched, not prescribed in detail here — see file 02):** lift `useBriefingStream(mode)`, `useReconnectPolicy()`, and `useDemoCapture(insights, workspace, trace)` into hooks. The page becomes layout + composition.

### 3. Unknown-unknowns — `filterByStep`

The demo replay path in the agent route filters the cached event stream by step (diagnose vs recommend). The filter is shape-aware, but the shapes it cares about are defined in a different file.

```
app/api/agent/route.ts  (lines 66–84)

  function filterByStep(events: AgentEvent[], step: Step): AgentEvent[] {
    return events.filter((e) => {
      const agent =
        e.type === 'reasoning_step'                  ← inspects shape A
          ? e.step.agent
          : e.type === 'tool_call_start' || e.type === 'tool_call_end'
            ? e.agent                                 ← inspects shape B
            : null;
      if (step === 'diagnose') {
        if (e.type === 'recommendation') return false;
        if (agent === 'recommendation') return false;
        return true;
      }
      if (e.type === 'diagnosis') return false;
      if (agent && agent !== 'recommendation') return false;
      return true;
    });
  }
       │
       └─ this depends on:
            - AgentEvent.type tags  (events.ts L4–L12)
            - the `agent` field nested inside two specific variants
            - the `step` field on reasoning_step
          add a new event type to events.ts (say { type: 'metric'; ... })
          and this filter silently drops it from BOTH steps' replays.
          nothing in events.ts points at filterByStep.
```

**The fix:** either (a) move `filterByStep` next to the `AgentEvent` definition, so the two are obviously coupled, or (b) attach the agent owner to *every* event variant so the filter doesn't need shape-narrowing. Option (b) is the deeper fix.

---

## Elaborate

Ousterhout's three symptoms are diagnostic, not categorical. The same file can fire two symptoms (the page component fires cognitive load + a touch of change amplification, since the NDJSON parser duplicates parts of `useInvestigation`'s parser). When you find that, the cognitive-load fix usually retires the amplification too — extract the shared parser into a hook and both symptoms drop.

The honest framing for a small codebase: most APOSD complexity findings concentrate at the **boundaries between layers** (route ↔ UI, agent ↔ MCP, state ↔ route). Internals tend to be fine; the seams are where things drift. That matches this audit — three of the four findings cross a layer boundary.

What this guide doesn't claim: there's no algorithmic complexity hotspot in blooming insights. The graph algorithms, the priority queues, the state machines you'd worry about in a competitive-programming sense — none of those are here. The complexity is *structural*, and it lives in the wiring.

## Interview defense

**Q: How do you tell complexity from "this code is just doing a lot"?**
A: A file that does a lot but stays narrow — small interface, one concern — isn't complex; it's just big. `lib/mcp/client.ts` is 172 lines and does TTL cache + retry + spacing + error tagging, but the surface is one method (`callTool`). That's not complexity; that's depth. Complexity is when the *interface* grows to match the implementation — when the caller has to know all the inside parts. `app/page.tsx` is the opposite shape: the JSX is what it presents, but the implementation forces the reader to learn the NDJSON parser, the reconnect policy, and the demo capture before they can edit anything.

**Q: Which symptom would you fix first here?**
A: Cognitive load on `app/page.tsx`, because retiring it also reduces change amplification — the inline NDJSON parser is the second copy of the parser that already lives in `useInvestigation`. One refactor (extract `useBriefingStream`) fixes both. Unknown-unknowns I'd fix last; they're individually small and only bite at change time.

```
Interview-defense diagram — the fix-order question

   #1  fix app/page.tsx       ── retires cognitive load
       (extract hooks)        ── also retires amplification (parser dup)
       
   #2  unify insightToAnomaly ── retires amplification (Insight↔Anomaly)
       (move next to inverse)
       
   #3  attach `agent` to all   ── retires unknown-unknown (filterByStep)
       AgentEvent variants
```

## Validate

1. **Reconstruct.** Without opening the file: name the three symptoms of complexity, and name the file in blooming insights that fires each one most clearly.

2. **Explain.** Why is the agent → MCP seam (`McpCaller`, `lib/agents/base.ts` L16–L22) called out as praise, not debt? What does it have that the route → UI seam lacks?

3. **Apply.** A new event variant `{ type: 'progress'; percent: number; agent: AgentName }` lands in `lib/mcp/events.ts` L4–L12. Trace the unknown-unknowns: which files now silently drop or mishandle it? (Hint: `filterByStep` in `app/api/agent/route.ts` L66–L84 and the inline NDJSON reader in `app/page.tsx` L328–L437.)

4. **Defend.** Someone says "the page component is fine, it's just React — pages are always big." Counter the argument using cognitive load specifically — name the concerns the file holds and name the one a contributor wouldn't expect to be in there.

## See also

- `02-deep-vs-shallow-modules.md` — the depth axis, where the page component is named as the worst shallow module in the repo.
- `03-information-hiding-and-leakage.md` — the Insight↔Anomaly mapping reappears there as a hiding-leak.
- `08-red-flags-audit.md` — the capstone checklist, with these three findings ranked against every other red flag.
