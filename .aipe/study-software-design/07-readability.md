# Readability — names · comments · consistency · obviousness

**Industry name(s):** Naming · self-documenting code · interface comments · convention drift · principle of least astonishment
**Type:** Industry standard · Language-agnostic

> Readability isn't decoration — it's the part of design that determines whether the next contributor can change code safely. Four facets: precise *names* (so the variable's purpose can't be misread), *comments* that carry what the code can't (the "why" and the "where this fact lives elsewhere"), *consistency* (one convention per job), and *obviousness* (the reader's first guess about what the code does turns out to be right). blooming insights is generally strong here — the codebase reads like someone explained it on the way past — with one consistent smell (inline-CSS-heavy components) and two small naming nits.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Readability shows up at three altitudes. **At the file level**: are comments load-bearing or restating? In this codebase the comments are *load-bearing* — they document constraints, rationale, and gotchas, not "increment i by 1." That's praise. **At the module level**: are conventions consistent across sibling files? Mostly yes — the four agent classes follow the same shape; the route handlers follow the same NDJSON pattern; tests use a uniform `_clear` helper convention. **At the variable level**: precise vs vague. Almost everything is precise; two outliers (`r`, `cp` in derive functions) are worth naming but small.

```
Zoom out — readability altitudes

┌─ File-level (comments + structure) ───────────────────────────┐
│  base.ts          ★ comments carry constraints + protocol     │
│  client.ts        ★ comments carry the WHY (retry windows)    │
│  auth.ts          ★ comments document storage backend reasons │
│  page.tsx         ⚠ comments thin; structure carries it weakly│ ← we are here
└──────────────────────────┬────────────────────────────────────┘
                           │
┌─ Module-level (conventions across siblings) ──────────────────┐
│  agent classes    ★ same shape: ctor + one public method      │
│  routes           ★ same NDJSON encoder/decoder pattern        │
│  state modules    ★ same `_clear` test-helper convention       │
│  components/      ⚠ inline styles dominant; no Tailwind use   │
└──────────────────────────┬────────────────────────────────────┘
                           │
┌─ Variable-level (names) ──────────────────────────────────────┐
│  most names       ★ precise: anomaly, diagnosis, schema       │
│  `r`              ⚠ in derive.ts, `r = e?.result` (close call) │
│  `cp`             ⚠ findCurrentPrior return — abbrv. unclear  │
└────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when you open a file you haven't seen before, can you understand what it does without reading any other file? A file that succeeds is *self-anchored* — names disambiguate, comments fill in the constraints the names can't carry, conventions match what the neighbor files do, and the code's behavior matches what the reader's first guess was. The next four sub-sections take each facet, rank the audit, and name the one finding per facet.

---

## Structure pass

**Layers.** Readability cuts across all layers; the question shifts at each altitude. File-level (comments + structure) → module-level (conventions across sibling files) → variable-level (precise vs vague names) → reader-level (does behavior match first guess?).

**Axis: load-borne-by-code vs load-borne-by-comment.** For each unit (variable, function, file), what carries the meaning? When a precise name carries it, the comment is liberated to talk about *why*. When a vague name forces the reader to study the implementation, the comment has to restate the code — both fail the readability test. This is the right axis because it distinguishes "comment that helps" from "comment that's noise." Cost is wrong; control is wrong; this is uniquely the readability axis.

**Seams.** Four seams, one per facet. **Seam 1: names.** Mostly precise; two outliers. **Seam 2: comments.** Strongest facet in the repo — comments carry rationale, constraints, gotchas. **Seam 3: consistency.** Strong at module level; weak at component level (inline-CSS vs Tailwind class hybrid). **Seam 4: obviousness.** Mostly strong; one place the convention violates least-astonishment (the `started` ref guard in `useInvestigation` that's *not* cleaned up by intent).

```
Structure pass — readability seams

┌─ 1. LAYERS ──────────────────────────────────────────────┐
│  File · Module · Variable · Reader                         │
└─────────────────────────────┬────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  who carries the meaning: code or comment?                │
│  precise code → comment carries WHY                       │
│  vague code → comment restates WHAT (smell)               │
└─────────────────────────────┬────────────────────────────┘
                              │  one finding per facet
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  S1: names         ★ strong — 2 nits (`r`, `cp`)         │
│  S2: comments      ★ strongest facet — load-bearing       │
│  S3: consistency   ⚠ inline-CSS vs Tailwind hybrid       │
│  S4: obviousness   ★ strong — 1 deliberate surprise       │
│                      (started-ref-not-cleaned-up)          │
└─────────────────────────────┬────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the four facets

You know how `const userId = 'u_123'` reads instantly but `const x = 'u_123'` makes you scroll up to find where x came from? Same shape — naming carries half the cognitive load. Now extend: a name carries WHAT, a comment carries WHY, a convention carries WHERE-IT-FITS, and obviousness is whether your first guess about behavior was right. Four orthogonal facets; each fails differently.

```
The four facets, each fails differently

  NAMES               vague name → reader has to study implementation
                      ┌──────────┐
                      │ tmp, data│  → can mean anything
                      │ x, obj   │
                      └──────────┘

  COMMENTS            restating WHAT instead of explaining WHY
                      ┌──────────────────────────────────┐
                      │ // increment i by 1               │
                      │ i++                               │  ← useless
                      └──────────────────────────────────┘
                      ┌──────────────────────────────────┐
                      │ // 1100ms because the alpha       │
                      │ // server enforces ~1 req/s        │
                      │ minIntervalMs: 1100                │  ← useful
                      └──────────────────────────────────┘

  CONSISTENCY         two conventions for one job
                      file A: `style={{ color: '#fff' }}`
                      file B: `className="text-white"`     ← convention drift

  OBVIOUSNESS         reader's first guess turns out wrong
                      ┌──────────────────────────────────┐
                      │ const sorted = list.sort()        │  surprise: mutates!
                      │ console.log(list)                  │  reader didn't expect
                      └──────────────────────────────────┘
```

### Move 2 — facet 1: NAMES (mostly strong; two nits)

**Strong examples (praise):** `anomaly`, `diagnosis`, `recommendation`, `schemaCapabilities`, `runnableCategories`, `parseRetryAfterMs`, `forceFinal`, `synthesisInstruction`, `McpToolError`. Every one of these tells the reader exactly what's stored or what's happening — no abstraction by abbreviation, no `data` / `obj` / `tmp` smells.

**The two nits.**

```
Naming nits

  lib/insights/derive.ts L13
    function findCurrentPrior(evidence) {
      for (const e of evidence ?? []) {
        const r = e?.result as Record<string, unknown> | null;
                  ─
                  └─ `r` (one letter). reading this requires holding
                     "r means the result of evidence-item e" in your
                     head for the next 4 lines. precise would be:
                     const result = e?.result as ...
                  
  lib/insights/derive.ts L29
    export function deriveInsightFields(anomaly: Anomaly): Partial<Insight> {
      const out: Partial<Insight> = {};
      const cp = findCurrentPrior(anomaly.evidence);
            ──
            └─ `cp` (abbreviation). short for "currentPrior" presumably,
               but reading "cp.current" later requires the reader to
               remember the abbreviation. precise would be:
               const period = findCurrentPrior(anomaly.evidence)
               // period.current, period.prior — meaningful at the use site
```

Neither is a bug; both are micro-tax on a reader. Easy fixes; named because they're the only nits in the repo.

### Move 2 — facet 2: COMMENTS (strongest facet — load-bearing)

The comment style across this codebase is consistent and *load-bearing* — comments carry the WHY, not the WHAT. Examples:

```
Load-bearing comments — praise

  lib/mcp/connect.ts L82–L88
    // Bloomreach rate-limits per user GLOBALLY and states the window in the
    // error text — observed as both "(1 per 1 second)" and "(1 per 10 second)".
    // Proactive spacing stays at ~1.1s on purpose: spacing at the full 10s
    // window would cost ~60s for a 6-call investigation and blow the route's
    // 60s budget (app/api/agent). Instead, McpClient parses the stated window
    // from each 429 and waits it out on retry (see retryDelayMs/retryCeilingMs),
    // and the 60s response cache absorbs repeats.

  this comment tells you:
    1. WHAT the constraint is (1 req/N seconds)
    2. WHY 1100ms was chosen (not 10000ms — budget calculation)
    3. WHERE the related logic lives (McpClient retry parsing, the cache)
    4. WHAT BREAKS if you raise it (route budget blown)

  the code below it is one line:
    minIntervalMs: 1100,

  the comment is 6 lines. the code is 1. that ratio is correct — the WHY
  is the load, the literal is just the number.
```

Other strong examples: the `auth.ts` storage-backend selection comment (L24–L32 — explains why three backends), the `agent/route.ts` step routing comment (L24–L28 — explains the diagnose/recommend split), the `connect.ts` LIVE-VERIFICATION block at the top of the file (explicit list of what to verify against live Bloomreach).

**The pattern.** When a constant or a magic number is present, a multi-line comment above it carries the reason — the constraint, the budget calculation, or the cross-reference to where the related fact lives.

**One weak spot for completeness:** `app/page.tsx` has lighter commenting than the lib/ files. Some of the inline comments restate what the code does instead of why (e.g., `// reset the feed for this (re)load — important when toggling demo/live` — fine, but the body of the useEffect has fewer comments than its complexity deserves). Not a smell, just unevenness.

### Move 2 — facet 3: CONSISTENCY (strong at module-level; one drift)

**Strong consistency:** the four agent classes have identical shape (ctor + one public method that builds a system prompt, calls runAgentLoop, parses + validates). The route handlers both export `GET` with `maxDuration = 300` and the same NDJSON header set. Tests use a uniform `_clear*()` convention (see `_clearAuthStore`, `_clearInvestigationCache`, `_resetSchemaCache`, `_clear` on insights).

**The one consistency smell:** styling in components.

```
Styling convention drift

  components/feed/InsightCard.tsx (495 LOC)
    inline styles ~150 occurrences:
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '16px 20px',
      }}
    sprinkled tailwind:
      className="text-3xl lowercase"
      className="grid grid-cols-1 lg:grid-cols-3"

  components/shared/ProcessStepper.tsx
    same pattern — inline styles dominant, occasional tailwind

  app/page.tsx
    same pattern — both styles present

  the codebase HAS Tailwind installed (v4). it HAS a design tokens file
  (lib/design/tokens.ts). but the convention in practice is:
    1. layout via tailwind classes (grid, flex)
    2. all colors / spacing via inline style w/ CSS variables

  this works, but the next contributor opening InsightCard.tsx has to
  scan past ~150 inline `style={{...}}` objects to find the JSX shape.
  the convention isn't wrong — it's that there ISN'T one. some
  decisions go to tailwind, some go to inline CSS.

  the right move (not necessarily worth the cost today): commit to one.
  either pull every style into tailwind classes (heaviest payoff for
  readability, biggest churn) or pull every style into named style
  constants per component (lighter, still helps).
```

**Why this is named:** consistency failure isn't a bug, but it's a tax. Every time a contributor wants to change padding on an insight card, they have to ask "do I add a className or do I edit the style object?" The answer in this codebase today is "depends on what's already there in this file." That's the drift.

### Move 2 — facet 4: OBVIOUSNESS (mostly strong; one deliberate surprise)

**Strong examples:** the agent loop's `forceFinal` logic is named for what it does; the cache's `fromCache: true/false` is an obvious returned signal; the `coverageFor` function's `'full' | 'limited' | 'unavailable'` return matches its docstring exactly.

**The one deliberate surprise:**

```
The not-cleaned-up ref guard in useInvestigation

  lib/hooks/useInvestigation.ts L43–L48
    const startedRef = useRef(false);

    useEffect(() => {
      if (!id) return;
      if (startedRef.current) return;  ← run once per mount (survives StrictMode)
      startedRef.current = true;
      ...
       │
       └─ a reader expects "guard a fetch with a ref" to be paired with
          "abort the fetch on cleanup." this hook DELIBERATELY does NOT
          abort. the comment above the hook (L31–L36) explains why:
              React StrictMode (dev) mounts → cleans up → re-mounts;
              cancelling on the first cleanup, with the started-guard
              blocking the re-mount, aborted the stream and left the
              logs empty. The started-guard prevents a double fetch;
              the in-flight run simply completes (setState after
              unmount is a safe no-op).
       
       this is the surprise: cleanup is omitted by design. without the
       comment, a reader's first guess ("there's a bug — no cleanup")
       would be wrong. the comment IS the obviousness fix.
```

**Verdict:** the surprise is justified, the comment carries the WHY. This is what "obviousness via documentation" looks like when the code's behavior genuinely surprises — name the surprise, explain it. Not a smell.

### Move 3 — the principle

Readability is the part of design the compiler can't enforce. Strong types prevent some name-failure modes; tests catch some convention-drift; but the ratio of "comment carries the WHY vs comment restates the WHAT," the precision of variable names, and the consistency of conventions across sibling files are entirely on the author. The discipline is the same as everywhere: pick the strategy explicitly (this file uses inline styles; this file uses tailwind), document the WHYs that aren't obvious from the names, and use precise names so the comment can talk about something else.

---

## Primary diagram

The four-facet readability audit:

```
Readability audit — by facet

  FACET 1: NAMES
  ──────────────────────────────────────────────────────────────────
  ★ strong:   anomaly, diagnosis, recommendation, schemaCapabilities,
              runnableCategories, parseRetryAfterMs, forceFinal,
              synthesisInstruction, McpToolError, coverageFor,
              runnableCategories, isAnomalyArray, etc.
  ⚠ nits:     `r` in lib/insights/derive.ts L13
              `cp` in lib/insights/derive.ts L29

  FACET 2: COMMENTS  ★ strongest facet ★
  ──────────────────────────────────────────────────────────────────
  load-bearing comments throughout lib/ — carry constraints, rationale,
  budget calculations, cross-references. examples:
    lib/mcp/connect.ts L82–L88   (the 1100ms spacing rationale)
    lib/mcp/auth.ts L24–L32      (the three-backend selection)
    app/api/agent/route.ts L24–L28 (the step-split rationale)
    lib/mcp/connect.ts L1–L14    (the LIVE-VERIFICATION list)
  weakness:
    app/page.tsx — comments thinner; the big useEffect deserves more

  FACET 3: CONSISTENCY
  ──────────────────────────────────────────────────────────────────
  ★ strong:   - agent classes (4) have identical shape
              - routes (2) follow same NDJSON pattern
              - tests use uniform `_clear*` helper convention
              - the four `synthesisInstruction` strings (even though
                duplicated, they FOLLOW the same pattern — see file 03)
  ⚠ drift:    inline `style={{...}}` vs Tailwind classes across all
              components — no clear "which one when" convention.

  FACET 4: OBVIOUSNESS
  ──────────────────────────────────────────────────────────────────
  ★ strong:   forceFinal, fromCache, coverageFor return values,
              every test file name maps 1:1 to source file
  ⚠ deliberate surprise:  useInvestigation's ref-guard with no cleanup
                          (justified by the strictmode comment — fine,
                           noted for completeness)
```

---

## Implementation in codebase

### NAMES — the nits, side by side with the praise

```
lib/insights/derive.ts  (lines 12–20)

  function findCurrentPrior(evidence: Anomaly['evidence']): { current: number; prior: number } | null {
    for (const e of evidence ?? []) {
      const r = e?.result as Record<string, unknown> | null;
                ─
                └─ NIT: `r` is one letter. precise would be `result`.
                   not load-bearing — the function is short — but the
                   abbreviation costs nothing to fix.
      if (r && typeof r.current === 'number' && typeof r.prior === 'number') {
        return { current: r.current, prior: r.prior };
      }
    }
    return null;
  }


lib/insights/derive.ts  (lines 27–39)

  export function deriveInsightFields(anomaly: Anomaly): Partial<Insight> {
    const out: Partial<Insight> = {};
    const cp = findCurrentPrior(anomaly.evidence);
          ──
          └─ NIT: `cp` is short for "current/prior" presumably. reading
             `cp.current` later requires the reader to remember it.
             precise: `const period = findCurrentPrior(...)`
    if (cp && REVENUE_RE.test(anomaly.metric) && anomaly.change.direction === 'down') {
      out.revenueImpact = {
        lostUsd: Math.round(cp.current - cp.prior),
        expectedUsd: Math.round(cp.prior),
        currency: 'USD',
      };
    }
    return out;
  }
```

Contrast with `lib/mcp/client.ts` L98 where the variable is `cacheKey`, not `k`:

```
lib/mcp/client.ts  (lines 97–103)  — for contrast (praise)

  async callTool<T = unknown>(name, args, options = {}): Promise<CallToolResult<T>> {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
          ────────
          └─ precise name. the reader doesn't have to ask "what is k for?"
    const ttl = options.cacheTtlMs ?? 60_000;
    ...
```

### COMMENTS — load-bearing examples

```
lib/mcp/connect.ts  (lines 82–88)

    // Bloomreach rate-limits per user GLOBALLY and states the window in the
    // error text — observed as both "(1 per 1 second)" and "(1 per 10 second)".
    // Proactive spacing stays at ~1.1s on purpose: spacing at the full 10s
    // window would cost ~60s for a 6-call investigation and blow the route's
    // 60s budget (app/api/agent). Instead, McpClient parses the stated window
    // from each 429 and waits it out on retry (see retryDelayMs/retryCeilingMs),
    // and the 60s response cache absorbs repeats. retryDelayMs falls back to the
    // observed 10s window when no hint is parseable.
    return {
      ok: true,
      mcp: new McpClient(new SdkTransport(client, httpErrors), {
        minIntervalMs: 1100,
        retryDelayMs: 10_000,
        retryCeilingMs: 20_000,
        maxRetries: 3,
      }),
    };
       │
       └─ the comment carries:
            1. the observed constraint (1 per N seconds, N varies)
            2. the rationale for 1100 (not 10000 — budget math)
            3. the related logic location (retry parsing + cache)
            4. the consequence of changing it (route budget blown)
          the code below is just numbers. the comment IS the design.
```

```
lib/mcp/auth.ts  (lines 21–34)

  // Storage backend, keyed by our app session id. Three backends, selected by env:
  //
  //   • development → a gitignored file (.auth-cache.json). Next's dev server
  //     re-evaluates modules on hot-reload, which would wipe an in-memory Map
  //     mid-OAuth-flow (the DCR client info + PKCE verifier saved during `connect`
  //     must survive until the `callback` exchanges the code), so dev persists.
  //   • test → in-memory Map (isolated per run; `_clearAuthStore` resets it).
  //   • production (Vercel) → an encrypted httpOnly cookie, via `withAuthCookies`
  //     below. The `connect` and `callback` requests run on different ephemeral
  //     instances, so the browser cookie is the only state both can see.
  //
  // SECURITY: the dev cache holds OAuth tokens in plaintext; it is local-only and
  // gitignored. The production cookie is AES-256-GCM encrypted under AUTH_SECRET.
       │
       └─ this is documenting THREE backend choices and the WHY for each.
          the reader doesn't have to spelunk through hot-reload behavior
          and ephemeral-instance semantics — the comment carries it.
          security note at the end is the kind of WHY-callout that
          inline code can never carry.
```

### CONSISTENCY drift — inline styles vs Tailwind

```
components/feed/InsightCard.tsx  (lines 174–217 sampled)

  <Link
    href={`/investigate/${insight.id}`}
    style={{ textDecoration: 'none', display: 'block' }}    ← inline
  >
    <article
      className="bi-fade-up"                                 ← className
      style={{
        background: 'var(--bg-surface)',                    ← inline
        border: '1px solid var(--border)',                  ← inline
        borderRadius: 4,                                     ← inline
        padding: '16px 20px',                                ← inline
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                                                              ← inline (could be Tailwind: flex items-center gap-2 mb-1.5 flex-wrap)
        <SeverityBadge severity={insight.severity} />
        <span
          className="uppercase"                              ← className
          style={{
            fontFamily: 'var(--font-mono), monospace',      ← inline
            fontSize: '0.66rem',                             ← inline (could be Tailwind: text-[0.66rem])
            fontWeight: 600,
            letterSpacing: '0.06em',
            color: sevColor,
          }}
        >
       │
       └─ no convention: utility classes for SOME things (uppercase, flex layout
          via Tailwind in other files), inline style{{...}} for spacing/sizing/color.
          the reader can't predict where to look. that's the drift.
```

### OBVIOUSNESS — the justified surprise

```
lib/hooks/useInvestigation.ts  (lines 31–48)

  /** ...
   *  NOTE: we deliberately do NOT cancel the fetch on effect cleanup. React
   *  StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first
   *  cleanup, with the started-guard blocking the re-mount, aborted the stream
   *  and left the logs empty. The started-guard prevents a double fetch; the
   *  in-flight run simply completes (setState after unmount is a safe no-op). */
  export function useInvestigation(id: string | undefined, step: InvestigationStep): InvestigationState {
    const [items, setItems] = useState<TraceItem[]>([]);
    ...
    const startedRef = useRef(false);

    useEffect(() => {
      if (!id) return;
      if (startedRef.current) return; // run once per mount (survives StrictMode)
      startedRef.current = true;
      ...
       │
       └─ the surprise (no cleanup) is the right call — the alternative was a
          worse bug. the comment makes it obvious by naming the alternative
          and saying why it was rejected. this is what "make the obvious-but-
          wrong path explicitly closed" looks like.
```

---

## Elaborate

The deeper readability move is to **let the comment talk about something the code can't.** Strong types carry the WHAT for free; tests carry behavior for free; you're left with the WHY — design decisions, constraints from external systems, gotchas the next contributor will hit. The codebase already does this in most lib/ files. The under-commented region (`app/page.tsx`) is exactly the region with the cognitive load problem (file 01) — and those two findings are linked. Lighter comments on more complex code is the worst combination; the page component fires both.

A non-finding worth naming as praise: the test file naming convention is 1:1 with source files (`lib/agents/base.ts` ↔ `test/agents/base.test.ts`). When you open the source, you know exactly where the tests live. That's a tiny consistency win, but it adds up — a reader doesn't have to grep to find tests.

The `tokens.ts` file (7 lines, `lib/design/tokens.ts`) is a deliberate near-empty design token registry — looks unfinished, but it's the seam where design tokens *would* live as they grow. Naming it for completeness: not a smell, an open slot.

## Interview defense

**Q: What's the readability strength of this codebase?**
A: Comments. Throughout the `lib/` files, comments carry the WHY, not the WHAT — the rationale, the budget calculation, the cross-reference to where the related fact lives. The 1100ms spacing in `lib/mcp/connect.ts` L82–L88 is the strongest example: 6 lines of comment for 1 line of code, and every line of comment is load-bearing (constraint, math, related logic, consequence). The pattern is consistent across `auth.ts`, `agent/route.ts`, the `runAgentLoop` JSDoc, the `LIVE-VERIFICATION` block at the top of `connect.ts`. The next contributor doesn't have to spelunk to learn the WHYs.

**Q: What's the worst consistency drift?**
A: Styling in components. The codebase has Tailwind installed (v4) AND uses inline `style={{...}}` with CSS variables. The convention in practice is "layout via Tailwind, everything else inline," but it's not stated — and even layout has exceptions. `InsightCard.tsx` (495 lines) has ~150 inline style objects mixed with occasional className uses. The reader can't predict where to look. The fix isn't necessarily to migrate to Tailwind (that's a big churn) — the smaller fix is to pull style objects into named constants per component (`cardStyle`, `tileStyle`), so the JSX reads as JSX again.

```
Interview-defense diagram — the styling drift, and the small fix

  before:
  <article style={{
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: '16px 20px',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      ...

  after (small fix — pull to named constants):
  const cardStyle: CSSProperties = { background: 'var(--bg-surface)', ... }
  const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }

  <article style={cardStyle}>
    <div style={rowStyle}>
      ...
       ▲
       │
       JSX reads as JSX. styles are named and reusable.
       smaller change than a Tailwind migration; retires most of the drift.
```

## Validate

1. **Reconstruct.** Without opening the file: name the two variables in `lib/insights/derive.ts` that fail the precise-naming test. What would precise versions be?

2. **Explain.** Why is the 6-line comment above `minIntervalMs: 1100` in `lib/mcp/connect.ts` L82–L88 considered "load-bearing" — what does it carry that the code below it can't?

3. **Apply.** Open `components/feed/InsightCard.tsx`. Count the number of inline `style={{...}}` objects vs the number of `className=` attributes (rough estimate is fine). Is the convention consistent enough to predict where to add new styles?

4. **Defend.** Someone says "the not-cleaned-up ref guard in `useInvestigation` is a bug — every React hook should clean up its effects." Counter using the comment at L31–L36. (Hint: the comment explicitly names the alternative that was tried and failed — cancelling on first cleanup aborted the stream and left the logs empty in StrictMode. The surprise is justified, the comment carries the WHY, and "setState after unmount is a safe no-op" is the closing argument.)

## See also

- `01-complexity-in-this-codebase.md` — `app/page.tsx`'s thin comments amplify its cognitive load.
- `03-information-hiding-and-leakage.md` — comments are the documentation half of hiding (the secret + its justification).
- `08-red-flags-audit.md` — "vague name," "comment restates code," and "convention drift" red flags are scored.
