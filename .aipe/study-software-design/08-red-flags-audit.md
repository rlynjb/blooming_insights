# Red flags audit — the capstone

**Industry name(s):** APOSD red flags · design-review checklist · "smells that fire here"
**Type:** Industry standard · Language-agnostic

> Ousterhout's red flags as a review checklist, each marked against this repo: **fires** (named with file path and the one-line fix), **doesn't fire** (with why), or **N/A** (with why this codebase doesn't exercise the primitive enough to tell). This is the ranked, actionable index that the other seven concept files feed.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The capstone collapses the audit into a single sorted checklist. Every finding in files 01–07 has a row here, plus rows for red flags that *don't* fire (those are praise — they're findings too). The ranking is by severity for *this codebase*, not the book's universal order — a small codebase like this one weights cognitive-load on the page component above, say, "generic container reused for unrelated types."

```
Zoom out — the red-flags checklist as one frame

┌─ The 12 red flags evaluated ────────────────────────────────────┐
│  FIRES (3, ranked)                                              │
│   #1  shallow module (app/page.tsx)            CRITICAL          │
│   #2  information leakage (Insight↔Anomaly)    HIGH              │
│   #3  special-case sprawl (synthesize ×2)       HIGH              │
│                                                                 │
│  FIRES MINOR (3)                                                 │
│   #4  pass-through method (McpClient.listTools) LOW (earned)     │
│   #5  vague names (`r`, `cp`)                   LOW              │
│   #6  convention drift (inline-CSS vs Tailwind) MEDIUM           │
│                                                                 │
│  DOESN'T FIRE — PRAISE (4)                                       │
│   - classitis              4 agent classes earn their keep      │
│   - try/except everywhere  errors masked at clean boundaries    │
│   - comment restates code  comments load-bearing throughout     │
│   - hard-to-read names     >95% of names are precise            │
│                                                                 │
│  N/A — codebase too small/uniform (2)                            │
│   - temporal decomposition limited to synthesize() duplication  │
│   - exposed knobs everywhere  knobs are well-defaulted          │
└─────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: if you had one afternoon to spend on this codebase, what's the highest-leverage move? The answer is in the top of the FIRES list. Below it, ranked, is the rest of the work. Below that, what's working well (so you don't accidentally break it). The next sections walk each row.

---

## Structure pass

**Layers.** The capstone has no layered structure of its own — it's the projection of every other file's findings onto a single ranked list. The structural work happened in files 01–07.

**Axis: severity for *this codebase*.** Not the abstract worst-case severity, but the practical "if the next contributor reads only one finding, which one matters most for them." This biases toward high-cognitive-load hotspots and silent-data-loss leaks over micro-tidiness.

**Seams.** One implicit seam: the line between "fires here, fix it" and "doesn't fire here, don't accidentally introduce it." The praise section is as load-bearing as the debt section — naming what's healthy is how you protect it.

```
Structure pass — the ranking lens

┌─ 1. LAYERS ──────────────────────────────────────────────┐
│  one layer: the projection of files 01–07 onto severity   │
└─────────────────────────────┬────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  severity FOR THIS CODEBASE                               │
│  (the next contributor's pain, not the book's worst case) │
└─────────────────────────────┬────────────────────────────┘
                              │  one seam
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  S1: FIRES (with fix) vs DOESN'T FIRE (with praise)      │
│      both halves are findings — neglect either at cost    │
└─────────────────────────────┬────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the checklist as a tool

You know how a pre-flight checklist works — pilots don't *remember* to check fuel, they read down the list and the list says "fuel." Same shape here. The red-flags checklist is a tool you can hand the next contributor: every row is "look for THIS in your change; if it's present, the fix is THIS." A flat narrative of "things to avoid" teaches less than a checklist that prompts you to check.

```
The checklist shape

  ┌────────────────────────┐
  │ red flag name           │  ← what the smell is called
  ├────────────────────────┤
  │ where it fires here     │  ← file:line in this repo
  │ severity for this repo  │  ← critical / high / medium / low / n/a
  │ the one-line fix        │  ← what to do (or "leave alone, here's why")
  └────────────────────────┘
```

### Move 2 — the ranked checklist

The 12 red flags from APOSD, each marked against this codebase. Severity reflects pain for THIS repo's contributors, not abstract worst-case.

```
The red-flags checklist, ranked

╔══════════════════════════════════════════════════════════════════════════╗
║ #1 ─ SHALLOW MODULE                              SEVERITY: CRITICAL       ║
║ ──────────────────────────────────────────────────────────────────────── ║
║ FIRES: app/page.tsx (817 LOC, 8 concerns, ~14 useState slots all live    ║
║        at file scope).                                                    ║
║ FIX:   extract three hooks — useBriefingStream(mode),                     ║
║        useReconnectPolicy(), useDemoCapture(insights, workspace, trace). ║
║        page collapses to ~120 LOC of layout + composition.                ║
║ SEE:   file 01 (cognitive load), file 02 (the depth ranking).             ║
╠══════════════════════════════════════════════════════════════════════════╣
║ #2 ─ INFORMATION LEAKAGE                         SEVERITY: HIGH           ║
║ ──────────────────────────────────────────────────────────────────────── ║
║ FIRES: Insight↔Anomaly field-copy list — encoded in 3 files               ║
║        types.ts (interfaces), state/insights.ts L8–L28 (anomalyToInsight),║
║        api/agent/route.ts L29–L31 (insightToAnomaly). insightToAnomaly   ║
║        silently drops evidence/impact/history/category.                   ║
║ FIX:   colocate both mappings in lib/state/insights.ts; add a round-trip  ║
║        test asserting no field loss. Better: fix the wire format so the   ║
║        route doesn't convert — accept the bare insight id and look up.    ║
║ SEE:   file 03 (the leak walkthrough), file 04 (pass-through-shaped).     ║
╠══════════════════════════════════════════════════════════════════════════╣
║ #3 ─ SPECIAL-CASE SPRAWL ("temporal decomposition")  SEVERITY: HIGH       ║
║ ──────────────────────────────────────────────────────────────────────── ║
║ FIRES: synthesize() recovery method — duplicated in two agent classes:    ║
║        lib/agents/diagnostic.ts L86–L126                                  ║
║        lib/agents/recommendation.ts L82–L132                              ║
║        both serialize the tool-call history, call anthropic.messages with ║
║        a tool-less recovery prompt, and parse the result.                 ║
║ FIX:   lift recovery into runAgentLoop as parseResult + recoveryPrompt    ║
║        options. Both synthesize() methods delete. The agent classes pass  ║
║        their parser + a prompt builder; the loop owns the strategy.       ║
║ SEE:   file 06 (define-it-out fix), file 03 (logic-leak framing).         ║
╠══════════════════════════════════════════════════════════════════════════╣
║ #4 ─ CONVENTION DRIFT                            SEVERITY: MEDIUM         ║
║ ──────────────────────────────────────────────────────────────────────── ║
║ FIRES: inline `style={{...}}` vs Tailwind classes, no consistent rule.   ║
║        InsightCard.tsx (495 LOC) has ~150 inline style objects mixed     ║
║        with occasional className. Every other component file follows     ║
║        the same hybrid. Tailwind v4 is installed; design tokens.ts is    ║
║        a near-empty open slot.                                            ║
║ FIX:   small move first — pull repeated style objects into named         ║
║        constants per component (`cardStyle`, `tileStyle`, etc.) so the    ║
║        JSX reads as JSX. Bigger move (later): commit to Tailwind or      ║
║        CSS-in-JS and migrate. Don't half-do.                              ║
║ SEE:   file 07 (the four-facet readability audit).                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║ #5 ─ PARTIALLY-PUSHED-UP CONFIG                  SEVERITY: MEDIUM         ║
║ ──────────────────────────────────────────────────────────────────────── ║
║ FIRES: synthesisInstruction strings in all 4 agents — the role-specific  ║
║        shape clause is rightfully per-agent, but the boilerplate prefix  ║
║        ("You have NO more tool calls available...") and closer           ║
║        ("Do not say you need more queries") are duplicated 4 times.       ║
║ FIX:   add buildSynthesisInstruction(shape: string) to lib/agents/base.ts;║
║        agents pass just the shape clause. ~50 lines of duplicated text   ║
║        delete.                                                            ║
║ SEE:   file 05 (partial pull-down), file 03 (duplication framing).        ║
╠══════════════════════════════════════════════════════════════════════════╣
║ #6 ─ PASS-THROUGH METHOD                         SEVERITY: LOW (earned)   ║
║ ──────────────────────────────────────────────────────────────────────── ║
║ FIRES: McpClient.listTools (lib/mcp/client.ts L168–L171). One line:       ║
║        return this.transport.listTools(). No cache, no spacing, no retry.║
║ FIX:   none — the layer earns its keep at the IMPORT SURFACE. Without    ║
║        it, callers would have to import McpTransport alongside McpClient. ║
║        Documented in the comment above the method. Leave it.              ║
║ SEE:   file 04 (the pass-through framing + justification test).           ║
╠══════════════════════════════════════════════════════════════════════════╣
║ #7 ─ VAGUE NAMES                                 SEVERITY: LOW            ║
║ ──────────────────────────────────────────────────────────────────────── ║
║ FIRES: two nits, both in lib/insights/derive.ts.                          ║
║        L13: `const r = e?.result as ...` (should be `result`).            ║
║        L29: `const cp = findCurrentPrior(...)` (should be `period`).      ║
║ FIX:   one-line rename. The rest of the codebase is precise — these are   ║
║        outliers, not a pattern.                                           ║
║ SEE:   file 07 (facet 1: names).                                          ║
╚══════════════════════════════════════════════════════════════════════════╝
```

### Move 2 — the red flags that don't fire (praise)

These four are findings too — they're the patterns to preserve.

```
The four red flags that DON'T fire (praise)

╔══════════════════════════════════════════════════════════════════════════╗
║ PRAISE #1 ─ CLASSITIS                            DOESN'T FIRE              ║
║ ──────────────────────────────────────────────────────────────────────── ║
║ The four agent classes (MonitoringAgent, DiagnosticAgent, etc.) each     ║
║ have a ctor + one public method — close to classitis, but each method    ║
║ does real work: prompt build + parse + validate + sort/slice. None is    ║
║ a thin wrapper. They earn their keep weakly (the class shape collects     ║
║ the constructor args once instead of threading them through every call). ║
║ JUDGE-CALL: keep as classes; the constructor-once pattern beats           ║
║ functions-with-shared-options-bag at this size.                           ║
╠══════════════════════════════════════════════════════════════════════════╣
║ PRAISE #2 ─ TRY/CATCH EVERYWHERE                 DOESN'T FIRE              ║
║ ──────────────────────────────────────────────────────────────────────── ║
║ Error handling clusters at three intentional boundaries: MCP wrapper     ║
║ (mask rate-limits, transform transport errors), agent loop (mask tool    ║
║ failures via is_error tool_result), agent classes (mask parse failures   ║
║ via [] / FALLBACK). Every other layer reads error-free. The route        ║
║ handlers catch ONCE at the top and convert to NDJSON error events.       ║
║ JUDGE-CALL: this is the textbook "boundaries with contracts" shape.      ║
║ Protect it as the codebase grows.                                         ║
╠══════════════════════════════════════════════════════════════════════════╣
║ PRAISE #3 ─ COMMENTS RESTATE CODE                 DOESN'T FIRE             ║
║ ──────────────────────────────────────────────────────────────────────── ║
║ Comments throughout lib/ carry the WHY, not the WHAT. The 6-line block   ║
║ above `minIntervalMs: 1100` in connect.ts is the strongest example: it   ║
║ carries the constraint, the math, the related logic location, and the    ║
║ consequence of changing it. The auth.ts storage-backend comment, the     ║
║ LIVE-VERIFICATION block, and the step-split rationale in the agent       ║
║ route are similar. WHAT is in the code; WHY is in the comments. Right.  ║
║ JUDGE-CALL: this is the codebase's strongest readability facet.           ║
╠══════════════════════════════════════════════════════════════════════════╣
║ PRAISE #4 ─ HARD-TO-READ NAMES                    DOESN'T FIRE             ║
║ ──────────────────────────────────────────────────────────────────────── ║
║ >95% of names are precise: anomaly, diagnosis, recommendation,            ║
║ schemaCapabilities, runnableCategories, parseRetryAfterMs, forceFinal,    ║
║ synthesisInstruction, McpToolError. Two outliers (`r`, `cp` in            ║
║ derive.ts) are the exception, not the pattern.                            ║
║ JUDGE-CALL: keep the discipline. precise-by-default is what lets every    ║
║ comment talk about something other than restating the code.               ║
╚══════════════════════════════════════════════════════════════════════════╝
```

### Move 2 — the red flags that are N/A here

A small codebase doesn't exercise every primitive. Naming honestly what doesn't fire is part of the audit.

```
N/A — codebase too small/uniform

╔══════════════════════════════════════════════════════════════════════════╗
║ N/A #1 ─ TEMPORAL DECOMPOSITION                                            ║
║ The book's classic example is "open file, then read it, then close it,    ║
║ as three methods exposed to callers" — splitting on TIME instead of      ║
║ purpose. The closest this repo gets is the synthesize() duplication      ║
║ (#3 above), which is mild temporal decomposition. No true 3-step         ║
║ open-process-close exposed surfaces exist yet. Re-check as the codebase  ║
║ grows.                                                                    ║
╠══════════════════════════════════════════════════════════════════════════╣
║ N/A #2 ─ EXPOSED KNOBS EVERYWHERE                                          ║
║ The codebase has knobs but they're well-defaulted: McpClient's 4         ║
║ retry/spacing options default sanely; runAgentLoop's maxTurns/           ║
║ maxToolCalls default to 8/—; the schema cache has no knob at all. No    ║
║ caller-burdening configuration smell. (See file 05 for the one          ║
║ partially-pushed-up case: synthesisInstruction, captured under #5.)      ║
╚══════════════════════════════════════════════════════════════════════════╝
```

### Move 3 — the principle

A red-flags audit isn't a moral judgment on the code — it's a *checklist* the next contributor can run against any change. Every PR should land green against most of these rows; landing red on one means there's a deliberate reason that should be named in the PR description. The audit's value isn't the finding count; it's the prompt to check.

---

## Primary diagram

The whole checklist, as one frame:

```
THE RED-FLAGS AUDIT — single-frame view

                       SEVERITY FOR THIS CODEBASE
   ┌──────────────────────┬──────────────────────────────────────────────┐
   │ CRITICAL             │ #1 shallow module — app/page.tsx (817 LOC)   │
   ├──────────────────────┼──────────────────────────────────────────────┤
   │ HIGH                 │ #2 information leakage — Insight↔Anomaly (3) │
   │                      │ #3 special-case sprawl — synthesize() (×2)   │
   ├──────────────────────┼──────────────────────────────────────────────┤
   │ MEDIUM               │ #4 convention drift — inline-CSS vs Tailwind │
   │                      │ #5 partially-pushed-up — synthesisInstruction│
   ├──────────────────────┼──────────────────────────────────────────────┤
   │ LOW                  │ #6 pass-through method — listTools (earned)  │
   │                      │ #7 vague names — `r`, `cp` (2 nits)          │
   ├──────────────────────┼──────────────────────────────────────────────┤
   │ DOESN'T FIRE (praise)│ classitis · try/catch sprawl · comment-as-   │
   │                      │ restatement · hard-to-read names             │
   ├──────────────────────┼──────────────────────────────────────────────┤
   │ N/A (too small)      │ temporal decomposition · exposed-knob sprawl │
   └──────────────────────┴──────────────────────────────────────────────┘

   reading order for an afternoon-of-cleanup:
     1. #1 first (biggest leverage; retires #5's cognitive-load contribution)
     2. #2 next (silent data-loss bug; small change, big confidence win)
     3. #3 (~half-day refactor; deletes ~100 LOC, retires duplication)
     4. #5 (~30 mins; small, satisfying)
     5. #4 — pull style objects to constants (~few hours; or defer to a sprint)
     6. #7 (5 mins)
     7. #6 — leave alone (it earns its keep)
```

---

## Implementation in codebase

### #1 in detail — app/page.tsx, the critical one

```
app/page.tsx  (817 lines, the worst shallow module in the repo)

  concerns held at one altitude:
    L1–L94    types + small helpers
    L95–L150  14 useState slots
    L156–L256 demo-capture flow (postCapture, runInvestigation, captureAll)
    L258–L476 one 218-line useEffect — fetch + NDJSON loop + 9 event handlers
    L478–L817 JSX — reads ALL 14 state slots
       │
       └─ no inner module to hide any of it. interface ≈ implementation.

  the fix in one diagram:
  ┌─ before ─────────────────────┐    ┌─ after ──────────────────────┐
  │  app/page.tsx                 │    │  app/page.tsx (~120 LOC)     │
  │  817 LOC, 8 concerns          │ ─► │  layout + composition         │
  │  14 useState · NDJSON loop ·  │    └──┬──────┬──────┬─────────────┘
  │  capture · reconnect · steppr │       │      │      │
  └───────────────────────────────┘       ▼      ▼      ▼
                                    useBriefing useRecon useDemo
                                    Stream      Policy   Capture
                                    (~150)      (~30)    (~80)
```

**One-line fix:** extract three hooks. Each hook becomes its own deep module with a small return shape hiding a fat body.

### #2 in detail — the Insight↔Anomaly leak

```
The three locations the field-copy list lives:

  lib/mcp/types.ts                     interface Anomaly + interface Insight
  lib/state/insights.ts L8–L28          anomalyToInsight (copies 8 fields)
  app/api/agent/route.ts L29–L31        insightToAnomaly (copies 4, drops 4)

  silent drop: insightToAnomaly omits evidence, impact, history, category.
  add a new field to Anomaly and the round-trip silently loses it.
  TypeScript can't catch this — both functions are valid.

  one-line fix:
    move insightToAnomaly into lib/state/insights.ts next to its inverse.
    add a round-trip test: expect(toAnomaly(toInsight(a))).toEqual(a).
    delete the copy in app/api/agent/route.ts; import instead.

  deeper fix (recommended): change the wire format so /api/agent accepts
    only the insight id and looks up the cached anomaly server-side.
    the round-trip exists because the browser passes ?insight=<JSON>;
    accepting just the id retires the leak entirely.
```

### #3 in detail — synthesize() duplication

```
Two copies, same shape:

  lib/agents/diagnostic.ts L86–L126  (40 lines)
    serialize toolCalls history → anthropic.messages.create with recovery
    prompt → parse with tryParseDiagnosis → return null on failure

  lib/agents/recommendation.ts L82–L132  (50 lines)
    serialize toolCalls history → anthropic.messages.create with recovery
    prompt → parse with tryParseRecommendations → return null on failure

  one-line fix: lift recovery into runAgentLoop.

    runAgentLoop({ ...,
      parseResult?: (text: string) => T | null,
      recoveryPrompt?: (toolCalls: ToolCall[]) => string,
    }): Promise<{ parsed: T | null, finalText, toolCalls }>

    diagnostic.ts collapses to:
      const { parsed } = await runAgentLoop({ ...,
        parseResult: tryParseDiagnosis,
        recoveryPrompt: buildDiagRecoveryCtx
      })
      return parsed ?? FALLBACK

    both synthesize() methods delete. ~90 LOC removed.
```

### #4 in detail — convention drift

```
The pattern across components/:

  inline:    style={{ background: 'var(--bg-surface)', ... }}
  tailwind:  className="grid grid-cols-1 lg:grid-cols-3"
  hybrid:    style={{...}} AND className=    in the same element

  the rule that ISN'T stated: layout via Tailwind, everything else inline.
  even that rule is broken in places.

  small fix (named over big fix because of churn cost):
    in each component, pull repeated style objects into named CSSProperties
    constants at the top of the file (cardStyle, tileStyle, rowStyle).
    JSX reads as JSX again. example already in components/investigation/
    EvidencePanel.tsx — it does this at L13–L46.

  big fix (later, if it becomes worth the churn):
    commit to one styling system. either migrate everything to Tailwind
    classes (heaviest payoff for readability, biggest churn) or commit
    to CSS-in-JS via styled-jsx / vanilla-extract. don't half-do.
```

### #5 in detail — synthesisInstruction duplication

```
Four copies, same shell, different shape clauses:

  lib/agents/monitoring.ts L102:    'You have NO more tool calls available. ...'
  lib/agents/diagnostic.ts L63:     'You have NO more tool calls available. ...'
  lib/agents/recommendation.ts L58: 'You have NO more tool calls available. ...'
  lib/agents/query.ts L42:          'You have NO more tool calls available. ...'

  prefix and closer are role-INDEPENDENT. shape clause is role-specific.

  one-line fix: add to lib/agents/base.ts:
    export function buildSynthesisInstruction(shape: string): string {
      return [
        'You have NO more tool calls available.',
        'Stop now and output your final answer.',
        shape,
        'Do not say you need more queries.',
      ].join(' ')
    }

  each agent passes:
    synthesisInstruction: buildSynthesisInstruction('Respond with ONLY a single JSON object...')
```

---

## Elaborate

A red-flags audit isn't a one-time exercise. It should re-run whenever the codebase grows by ~25% — every new feature might re-fire a row, retire one, or move severity. The current scoring will drift; the checklist persists.

The hardest discipline isn't catching the flags; it's *naming the praise rows* honestly. A reader who only sees "what's broken" learns half the lesson. The four don't-fire rows (classitis avoided, errors masked cleanly, comments load-bearing, names precise) are the patterns to preserve. If a future PR accidentally introduces try/catch sprawl or a vague variable name, the praise row is what tells the reviewer "we explicitly don't do that here."

Pattern across all 7 fires: **5 of 7 concentrate in one of two places.** The page component (which fires #1 and contributes to #4) and the agent classes (which fire #3, #5, and contribute to #4 indirectly via the styling on their UI counterparts). That clustering is itself a finding — the cleanup work has two natural fronts, not seven scattered tasks.

## Interview defense

**Q: If you had one afternoon on this codebase, what would you do?**
A: Extract three hooks from `app/page.tsx`. It's the worst shallow module in the repo (817 LOC, 8 concerns at one altitude, ~14 useState slots all live at file scope) and it fires the top of the red-flags checklist. The hooks — `useBriefingStream(mode)` for the fetch + NDJSON loop, `useReconnectPolicy()` for the sessionStorage-guarded auto-reconnect, and `useDemoCapture(insights, workspace, trace)` for the dev-only capture orchestration — collapse the page to ~120 LOC of layout + composition. Each hook becomes its own deep module. This single move retires the biggest cognitive-load hotspot AND the duplicated NDJSON parser (the same parser also lives in `useInvestigation`, so extracting `useBriefingStream` lets both share). Highest leverage in the repo.

**Q: What red flag DOESN'T fire here that you'd expect to?**
A: Try/catch sprawl. Looking at the codebase top-down, you'd expect a system with multi-layer streaming, OAuth, an MCP server with aggressive rate limits, and Anthropic-with-tool-use to be dotted with defensive try/catch everywhere. It isn't. Errors cluster at three intentional boundaries: `McpClient` masks rate-limits via parsed retry-after and transforms transport failures into `McpToolError`; `runAgentLoop` masks tool failures by feeding them back as `is_error: true` tool_result so the model can react; the agent classes mask parse/validate failures by returning `[]` or `FALLBACK`. Every other layer reads error-free. That's "errors as a contract at each boundary" — the strongest pattern in the codebase and the one I'd protect first as it grows.

```
Interview-defense diagram — the protect-as-it-grows pattern

  errors handled exactly at the contracts:
  
  ┌─ UI ─────────────────────────────────────────┐
  │  swallows malformed NDJSON lines             │  ← contract: stream is best-effort
  └─────────────────────┬────────────────────────┘
                        │ NDJSON event union (clean)
  ┌─ Route ─────────────▼────────────────────────┐
  │  emits { type: 'error' } when something below │  ← contract: ndjson always closes cleanly
  │  throws; converts setup errors to 500 JSON    │
  └─────────────────────┬────────────────────────┘
                        │ agent class methods (always return)
  ┌─ Agent class ───────▼────────────────────────┐
  │  masks parse/validate → [] or FALLBACK        │  ← contract: never throws
  └─────────────────────┬────────────────────────┘
                        │ runAgentLoop({...}) (always returns)
  ┌─ Loop ──────────────▼────────────────────────┐
  │  masks tool failures via is_error tool_result │  ← contract: model can react
  └─────────────────────┬────────────────────────┘
                        │ mcp.callTool(...) (clean or McpToolError)
  ┌─ McpClient ─────────▼────────────────────────┐
  │  masks rate-limits via parsed retry-after,    │  ← contract: success or tagged error
  │  transforms transport failures to McpToolError │
  └──────────────────────────────────────────────┘
```

## Validate

1. **Reconstruct.** Without opening the file: rank the top three red flags that FIRE in this codebase by severity. For each, name the file location and the one-line fix.

2. **Explain.** Why is `McpClient.listTools` flagged as a pass-through (severity LOW) but NOT marked as a fix-it row? What's the test that distinguishes "pass-through to delete" from "pass-through to keep"?

3. **Apply.** A new contributor adds a fifth agent class (`PredictionAgent`) following the same shape as the others. Which row of this checklist should fire? (Hint: #3 (synthesize) and #5 (synthesisInstruction) will both grow if the new agent ships before those two fixes — five copies instead of four.)

4. **Defend.** Someone says "this codebase is over-engineered — too many abstractions." Counter using the don't-fire / praise rows. (Hint: classitis doesn't fire because each agent class earns its keep; the deep modules — `McpClient`, `runAgentLoop`, `coverageFor` — earn their keep too, because deleting any of them would force every caller to learn the implementation. The abstractions that exist are paying for themselves.)

## See also

- `README.md` — the through-line + the top-three-fixes summary.
- `01-complexity-in-this-codebase.md` — the diagnostic that ranks the cognitive-load hotspots feeding #1.
- `02-deep-vs-shallow-modules.md` — the depth ranking that feeds #1 and #6.
- `03-information-hiding-and-leakage.md` — feeds #2 (the Insight↔Anomaly leak) and #3 (the synthesize duplication).
- `04-layers-and-abstractions.md` — feeds #6 (the pass-through justification).
- `05-pull-complexity-downward.md` — feeds #5 (synthesisInstruction partial pull-down).
- `06-errors-and-special-cases.md` — feeds the "errors masked at clean boundaries" praise row.
- `07-readability.md` — feeds #4 (convention drift), #7 (vague names), and the comments-load-bearing praise.
