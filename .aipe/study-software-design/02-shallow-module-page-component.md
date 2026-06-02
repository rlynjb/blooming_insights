# app/page.tsx as the shallow module

**Industry name(s):** Shallow module · classitis (file-level variant) · cognitive-load hotspot · god component
**Type:** Industry standard · Language-agnostic (the canonical anti-example in this repo)

> `app/page.tsx` is 817 lines, 14 `useState` slots, and eight independent concerns at one altitude: rendering, NDJSON stream parsing, reconnect policy, demo capture, mode toggling, coverage accumulation, trace accumulation, stepper-state derivation. The "interface" (the React render contract) is nearly as wide as the implementation — the JSX reads from all 14 state slots, so any external reader has to learn all 14 to follow the rendering logic. This is the worst shallow module in the codebase, and the file every other depth measurement is contrasted against.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three client-rendered pages exist in this repo. Two are calm: `app/investigate/[id]/page.tsx` (225 LOC, delegates to `EvidencePanel`, `StatusLog`, `useInvestigation`) and the smaller route pages. The third, `app/page.tsx`, is the feed — and it's where the codebase's cognitive load concentrates. Everything below it (route handlers, agents, MCP wrapper) is small and focused; the route layer emits a clean `AgentEvent` union; but the feed page parses that union inline, holds the demo/live switch, owns the reconnect dance, and accumulates trace + coverage state, all in one file scope.

```
Zoom out — where the shallow module lives

┌─ UI client band ───────────────────────────────────────────────┐
│  ★ app/page.tsx ★                  817 LOC, 8 concerns          │  ← we are here
│    14 useState · inline NDJSON loop · demo capture flow ·       │
│    reconnect policy · stepper derivation · JSX (339 LOC)        │
│                                                                  │
│  app/investigate/[id]/page.tsx     225 LOC (calm)               │
│  components/feed/InsightCard.tsx   495 LOC (inline-CSS heavy)   │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTP / NDJSON
┌─ Route handler band ─────▼─────────────────────────────────────┐
│  /api/briefing  /api/agent  — small, focused                    │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌─ lib/agents ─────────────▼─────────────────────────────────────┐
│  base.ts (177)  monitoring.ts (122)  diagnostic.ts (128)        │
│  small, focused, calm — no hotspots                             │
└─────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The pattern is the *failure* of the depth ratio. A deep module hides a lot behind a small interface; a shallow module exposes nearly as much as it implements. `app/page.tsx` exports one component (sounds narrow), but the implementation surfaces 14 `useState` slots that the JSX reads, plus 8 independent concerns the reader has to learn to edit anything. Interface ≈ implementation. Every contributor pays the cognitive-load tax on every edit. The fix is to introduce depth where none exists — extract three hooks, let the page collapse to layout + composition.

---

## Structure pass

**Layers.** Two for this concept: the **visible interface** (the JSX rendered + the implicit `useState` slot graph) and the **implementation** (the 14 state declarations + the 218-LOC `useEffect` + the 100-LOC demo-capture flow). Depth says: a deep module would have a thin interface over a fat body. Here the body and the interface are both fully visible.

**Axis: cognitive load per concern.** How many *independent* concerns does the file ask you to hold in your head before you can edit it safely? "Independent" is the load-bearing word — coupled concerns reduce to one (a state machine with 5 states is one concern); independent concerns don't (rendering + stream parsing + reconnect + demo capture are four orthogonal jobs sharing only the file scope).

**Seams.** No internal seams. That's the diagnosis — a deep module has at least one inner seam where one concern hides from another. This file has none. Every state slot is visible to every other state slot; every effect handler can mutate any of the 14 state setters. The fix introduces three seams (one per extracted hook) where currently there are zero.

```
Structure pass — the no-seam diagnosis

┌─ 1. LAYERS ──────────────────────────────────────────────┐
│  Visible interface (JSX + 14 state slots)                  │
│  Implementation (218-LOC effect + 100-LOC capture + JSX)  │
│  ratio: interface ≈ implementation                         │
└─────────────────────────────┬────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  cognitive load: how many independent concerns?           │
│  (independent = no shared state, no shared lifecycle)     │
└─────────────────────────────┬────────────────────────────┘
                              │  count concerns; locate seams
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  internal seams: ZERO                                     │
│  every state slot visible to every JSX read               │
│  every event handler can mutate any setter                │
│  the fix introduces 3 seams (one per extracted hook)     │
└─────────────────────────────┬────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the mental model (the wide-interface shape)

You know how a React component that only forwards props (`<Wrapper {...props} />`) does no work? The shallow module is the opposite failure: the component *does* a lot of work but the interface (the implicit "I read all these state slots") grows alongside the work, so nothing is hidden. Every new feature added to the file adds to both the body AND the surface. The depth ratio stays at 1:1 — interface tracks implementation step for step.

```
Shallow module — picture

  ┌────────────────────────────────────────────────────────────┐
  │                       INTERFACE                             │  ← what the reader has to learn
  │      (the JSX reads ALL 14 state slots: a wide contract)    │
  └────────────────────────────────────────────────────────────┘
  ┌────────────────────────────────────────────────────────────┐
  │                   IMPLEMENTATION                            │
  │   14 useState + 218-LOC useEffect + 100-LOC capture flow   │
  │   interface ≈ implementation — nothing hidden               │
  └────────────────────────────────────────────────────────────┘

  contrast with McpClient (the deep counterpart):
  ┌─────┐
  │intf │  ← 3 methods
  └─────┘
  ┌─────────────────────────────────────────────────────────┐
  │                  implementation                          │  ← 172 LOC absorbed
  └─────────────────────────────────────────────────────────┘
```

### Move 2 — the kernel (the eight concerns at one altitude)

Walk the eight concerns one at a time. Each is an independent job — none depends on the others to be understood, and editing any one requires scrolling past the rest.

**Concern 1: layout + JSX.** The actual UI rendering. ~339 LOC of JSX reading from all 14 state slots. The thing the user sees.

**Concern 2: NDJSON stream reader loop.** A for-loop over `reader.read()` with a UTF-8 byte buffer, splitting on `\n`, swallowing malformed lines, dispatching to a 9-case switch (`handle()`). ~90 LOC. The same shape lives in `lib/hooks/useInvestigation.ts:193-200` — that's the duplication that retires when this concern extracts.

**Concern 3: demo / live mode toggle + persistence.** Persists the mode to localStorage, reads it on mount, exposes a setter. The mode determines whether the stream URL points to the cache-replay endpoint or the live endpoint.

**Concern 4: dev-only demo-capture flow.** Three functions (`postCapture`, `runInvestigation`, `captureAll`) that walk every visible insight, run the diagnose + recommend steps against `/api/agent`, and POST the resulting traces to `/api/dev/capture` for the demo corpus. ~100 LOC. Dev-only, never runs in production.

**Concern 5: auto-reconnect on revoked token.** When the stream's `error` event matches a "revoked token" regex, the component calls `/api/mcp/reset`, marks a sessionStorage flag, and reloads. Buried inside the `error` event handler in the big effect.

**Concern 6: monitoring stepper state derivation.** Watches incoming `status` and `tool_call_start` events and derives the visible stepper state (which agent is active, which step it's on).

**Concern 7: coverage tile accumulation.** Receives the initial `coverage_report` event and stores it for the sidebar UI.

**Concern 8: trace item accumulation.** Receives every `reasoning_step` / `tool_call_start` / `tool_call_end` event and appends to a trace list rendered in the dev panel.

```
Pattern — the eight concerns, no seam between them

  ┌─ app/page.tsx (817 LOC) ───────────────────────────────┐
  │  L1–L94    types + small helpers                        │
  │  L95–L150  STATE (14 useState slots)                    │
  │  L156–L256 DEMO CAPTURE flow (100 LOC)                  │
  │  L258–L476 BIG EFFECT (218 LOC):                         │
  │              · fetch + NDJSON read loop                  │
  │              · 9-case handle() switch                    │
  │              · reconnect-on-revoked logic                │
  │              · stepper state derivation                  │
  │              · coverage + trace accumulation             │
  │  L478–L817 JSX (339 LOC) — reads all 14 state slots     │
  └─────────────────────────────────────────────────────────┘
         ▲
         │  touch ANY concern → scroll past 7 others first
         │  no inner module hides one from the others
```

### Move 2 — the fix (introduce three seams)

The repair is mechanical: extract three hooks. Each one becomes its own deep module with a small return shape hiding a fat body.

**Hook 1: `useBriefingStream(mode)`.** Returns `{ status, insights, workspace, coverage, traceItems, queryCount, stepStatus, errorMessage, reconnecting }`. Hides: the fetch, the NDJSON parse loop, the demo/live URL switch, every event handler in the 9-case switch. The biggest extraction — ~150 LOC moves out.

**Hook 2: `useReconnectPolicy()`.** Returns `{ reconnecting, triggerReconnect }`. Hides: the sessionStorage guard, the regex match on error text, the `/api/mcp/reset` call, the page reload. ~30 LOC moves out.

**Hook 3: `useDemoCapture(insights, workspace, trace)`.** Returns `{ capturing, captureAll }`. Hides: `postCapture`, `runInvestigation`, and the three-step orchestration that posts every diagnose + recommend trace to `/api/dev/capture`. Dev-only — gated by `NEXT_PUBLIC_ENABLE_CAPTURE`. ~80 LOC moves out.

The page collapses to:

```
Pseudocode — the after shape

  export default function HomePage() {
    const [mode, setMode] = useModePersistence()         // ~10 LOC hook
    const briefing       = useBriefingStream(mode)        // ~150 LOC hidden
    const reconnect      = useReconnectPolicy()            // ~30 LOC hidden
    const capture        = useDemoCapture(                 // ~80 LOC hidden
      briefing.insights, briefing.workspace, briefing.trace
    )

    return <LayoutAndJSX
      briefing={briefing}
      reconnect={reconnect}
      capture={capture}
      mode={mode} setMode={setMode}
    />
  }

  ~120 LOC total, all layout + composition.
  each hook is now a deep module: small return shape, fat hidden body.
```

### Move 3 — the principle

Module depth isn't about file size — it's about the *gap* between interface size and absorbed behavior. A 200-LOC component with a clean prop contract and minimal internal state is deep; a 200-LOC component that reads 14 state slots and holds eight concerns is shallow even though it's the same size. The right unit of measurement is "how much does the reader have to learn before they can edit one concern?" In a deep module that number is small. In a shallow one it's everything. The fix is never "delete lines"; it's "introduce a seam where one concern can hide from another." Three seams here. The lines stay in the codebase — they just move behind closed doors.

---

## Primary diagram

The before-and-after shape — the recap visual.

```
The shallow module → three deep hooks (the fix)

  BEFORE
  ┌─ app/page.tsx (817 LOC) ─────────────────────────────────┐
  │  14 useState · 218-LOC useEffect · 100-LOC capture flow   │
  │  9 event handlers · NDJSON loop · reconnect dance · JSX   │
  │  ─ no seam, no hiding, 8 concerns at one altitude ─       │
  └───────────────────────────────────────────────────────────┘

  AFTER
  ┌─ app/page.tsx (~120 LOC) ────────────────────────────────┐
  │  layout + composition only                                │
  └────┬──────────────┬──────────────┬───────────────────────┘
       │              │              │
       ▼              ▼              ▼
  ┌──────────┐  ┌──────────┐  ┌──────────────┐
  │useBriefin│  │useReconne│  │useDemoCapture │
  │gStream   │  │ctPolicy  │  │(dev-only)     │
  │~150 LOC  │  │~30 LOC   │  │~80 LOC        │
  │returns 9 │  │returns 2 │  │returns 2 fields│
  │fields    │  │fields    │  │               │
  └──────────┘  └──────────┘  └──────────────┘
   each hook = small return shape over fat hidden body
   the page is now a deep module of deep modules
```

---

## Implementation in codebase

**Use cases.** Three places this hotspot bites — chosen because they're the maintenance moments the next contributor will hit.

- **Adding a new agent event variant.** Say `{ type: 'progress'; percent: number; agent: AgentName }` lands in `lib/mcp/events.ts:4-12`. The contributor edits the type, then has to remember to add a case to the `handle()` switch inside the big `useEffect` (currently at `app/page.tsx:258-476`). Forget that and the new event silently drops. After the extraction, the case lives inside `useBriefingStream`'s switch — colocated with the other event handlers, easier to spot.

- **Changing the mode toggle persistence.** Today the read-from-localStorage call lives at file scope, the write-to-localStorage call lives inside a `useEffect`. After the extraction, both live inside `useModePersistence` and the page never touches `localStorage`.

- **Adding a second capture target (e.g. capture-by-anomaly-category).** Today the contributor opens 817 lines, finds the demo-capture region (L156-L256), reads through `postCapture` + `runInvestigation` + `captureAll`, then adds a fourth function. After extraction, they open the `useDemoCapture` file, see three small functions, add a fourth. The blast radius is one file the size of one concern.

### The shape today — every concern at one altitude

```
app/page.tsx  (817 lines)

  L1–L94    types + small helpers (stashInsights, readBody, formatCustomerCount)

  L95–L150  STATE — fourteen useState slots, all at file scope
    const [status, setStatus]               = useState<'loading'|'ok'|'error'>('loading')
    const [insights, setInsights]           = useState<Insight[]>([])
    const [workspace, setWorkspace]         = useState<WorkspaceMeta | undefined>(undefined)
    const [errorMessage, setErrorMessage]   = useState('')
    const [activeQuery, setActiveQuery]     = useState<string|null>(null)
    const [demoSuffix, setDemoSuffix]       = useState('')
    const [stepStatus, setStepStatus]       = useState('')
    const [queryCount, setQueryCount]       = useState(0)
    const [traceItems, setTraceItems]       = useState<TraceItem[]>([])
    const [coverage, setCoverage]           = useState<CoverageReport>([])
    const [reconnecting, setReconnecting]   = useState(false)
    const [capturing, setCapturing]         = useState({active:false,msg:''})
    const [mode, setMode]                   = useState<'demo'|'live'>('demo')
    const [ready, setReady]                 = useState(false)
                                            ────
                                            └─ every one of these is part of
                                               the JSX's implicit interface.
                                               nothing is hidden from anything else.

  L156–L256 DEMO CAPTURE — 100 lines, dev-only orchestration
    async function postCapture(payload) { ... }       ← POST to /api/dev/capture
    async function runInvestigation(id) { ... }       ← run diagnose + recommend
    async function captureAll() { ... }               ← orchestrate the walk

  L258–L476 BIG EFFECT — 218 lines, fetch + NDJSON + handlers
    useEffect(() => {
      let cancelled = false
      const controller = new AbortController()
      async function pump() {
        const res = await fetch(streamUrl, { signal: controller.signal })
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        function handle(ev: AgentEvent) {              ← 9-case switch
          switch (ev.type) {
            case 'workspace_meta':     ... 
            case 'coverage_report':    ...
            case 'reasoning_step':     ...
            case 'tool_call_start':    ...
            case 'tool_call_end':      ...
            case 'insight':            ...
            case 'diagnosis':          ...
            case 'status':             ...
            case 'error':              ... ← reconnect-on-revoked logic
          }
        }
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            try { handle(JSON.parse(line)) }
            catch { /* swallow malformed */ }
          }
        }
      }
      pump().catch(err => setErrorMessage(err.message))
      return () => { cancelled = true; controller.abort() }
    }, [mode])

  L478–L817 JSX — 339 lines reading from ALL 14 state slots
       │
       └─ every one of those 14 useState slots feeds into JSX somewhere.
          touching JSX requires scrolling past 470 lines of effect+capture
          first. touching the NDJSON loop requires scrolling past 150 lines
          of demo-capture you didn't ask to read.
          cognitive load is high because the concerns are INDEPENDENT —
          nothing about demo capture is needed to understand stream reading.
```

### Contrast — a calm page next door

```
app/investigate/[id]/page.tsx  (225 LOC, the calm sibling)

  export default function InvestigatePage({ params }) {
    const { id } = use(params)
    const diagnose = useInvestigation(id, 'diagnose')   ← hook hides the work
    const recommend = useInvestigation(id, 'recommend')  ← hook hides the work
    return (
      <Layout>
        <EvidencePanel diagnosis={diagnose.diagnosis} />
        <RecommendationsPanel items={recommend.items} />
        <StatusLog items={[...diagnose.items, ...recommend.items]} />
      </Layout>
    )
  }
       │
       └─ this is what the fixed page.tsx looks like at the next altitude.
          ~50 LOC of layout + composition; hooks do the work; components
          render. the depth is in the hooks and the components, not the page.
```

`useInvestigation` is the proof-of-concept for the proposed `useBriefingStream` — it already extracts the NDJSON parser from a page component into a hook with a small return shape. The pattern works; it just hasn't been applied to the feed page yet.

---

## Elaborate

Where the pattern comes from: this isn't unique to React. Ousterhout's red flags include "shallow module" and "classitis" — both describe the same failure shape at different scales. The React-specific name is "god component" but the mechanism is the same: one file accumulates concerns because there's no friction to adding a new `useState`. Junior devs add state; senior devs add hooks. The hook is the seam React provides for extracting depth.

A subtle correctness point: refactoring this file is *not* about reducing line count. The 817 lines don't disappear — they move into three files. What changes is the *visibility surface* per concern. A reader who wants to understand stream parsing opens `useBriefingStream.ts` and sees ~150 lines of parsing logic; they don't have to scroll past demo-capture and reconnect code first. The cognitive load drops because the seams hide concerns from each other.

The trajectory if the file keeps growing: eventually someone splits the page anyway (when adding the ninth concern becomes painful enough). The cost of doing it now vs later is the work itself plus the bugs introduced by every contributor who edits the file in the meantime. The hooks-extraction refactor is the kind of cleanup that takes an afternoon and removes the biggest reason the next contributor would get lost.

A non-finding worth naming as praise: `app/investigate/[id]/page.tsx` already shows what good looks like at the page level. It delegates everything that's not layout to hooks (`useInvestigation`) and components (`EvidencePanel`, `StatusLog`). The feed page doesn't have to invent a new pattern — it has to apply the pattern its sibling page already uses.

What to read next: the `read-aposd` chapter on shallow modules (when present) carries the full conceptual treatment. The `01-mcp-client-deep-module.md` file in this guide is the contrast — same depth axis, opposite verdict.

## Interview defense

**Q: This file is 817 lines. Isn't the right answer just "make it shorter"?**
A: Line count isn't the metric. The metric is the *ratio* of interface surface to absorbed behavior. The feed page is shallow because the JSX reads from 14 state slots and the file holds eight independent concerns — the interface (everything a contributor has to learn to edit safely) tracks the implementation step-for-step. A deep 817-LOC file would have a narrow interface (small return shape, few props, clear contract) over the same lines. The fix isn't to delete lines; it's to introduce three seams where one concern can hide from another. Extract `useBriefingStream`, `useReconnectPolicy`, `useDemoCapture`. The page collapses to ~120 lines of layout + composition; each hook becomes its own deep module. The total lines barely change — the visibility surface per concern drops by ~75%.

**Q: How do you decide which concerns to extract together and which to keep separate?**
A: Two tests. (1) Do they share state-shape, lifecycle, or input? `useBriefingStream` extracts everything that depends on the NDJSON stream — the parser, the 9-case handler, the coverage/trace/stepper derivations downstream of stream events. They share input (the stream) and lifecycle (mount → connect → tear down). (2) Is the boundary stable enough to be a contract? `useReconnectPolicy` returns `{ reconnecting, triggerReconnect }` — that's a contract the page can rely on without knowing about sessionStorage flags or page reloads. `useDemoCapture` returns `{ capturing, captureAll }` — same shape. If you can't write the return-shape interface in one line, the boundary isn't stable; reshape until you can.

```
Interview-defense diagram — the extraction logic

  start: 8 concerns at one altitude
    1. rendering
    2. NDJSON parsing
    3. mode toggle
    4. demo capture
    5. reconnect policy
    6. stepper derivation
    7. coverage accumulation
    8. trace accumulation

  group by shared input + lifecycle:
    ┌─ stream-driven (2, 6, 7, 8) → useBriefingStream
    ├─ reconnect-on-error  (5)    → useReconnectPolicy
    ├─ dev-only orchestrate (4)   → useDemoCapture
    ├─ persistent toggle   (3)    → useModePersistence (small)
    └─ rendering           (1)    → stays in the page

  return-shape test (one line each):
    useBriefingStream(mode):      { status, insights, workspace, coverage,
                                    traceItems, queryCount, stepStatus,
                                    errorMessage, reconnecting }
    useReconnectPolicy():         { reconnecting, triggerReconnect }
    useDemoCapture(...):           { capturing, captureAll }
    useModePersistence():         [ mode, setMode ]

  page after: just layout + composition → ~120 LOC
```

## Validate

1. **Reconstruct.** Without opening the file: name the eight concerns held at one altitude in `app/page.tsx`. Which three hooks would extract them, and what's the return shape of each?

2. **Explain.** Why is the depth ratio the right measure here, rather than line count? A 200-LOC file with 14 useState slots is shallower than an 800-LOC file with 2 useState slots — explain the mechanism.

3. **Apply.** Open `app/investigate/[id]/page.tsx` (225 LOC). Why is this page calm despite being non-trivial? Name the hooks it delegates to and trace what each one hides. (Hint: `useInvestigation` already extracts NDJSON parsing into a hook — that's the proof-of-concept for `useBriefingStream`.)

4. **Defend.** A reviewer says "extracting hooks for a single component is over-engineering — keep it simple." Counter using the cognitive-load argument. (Hint: the page already isn't simple — it has 8 concerns. The hooks aren't *adding* abstraction; they're *exposing* the abstraction that already exists informally. The cost is paid once; the benefit is paid every edit.)

## See also

- `audit.md` — the deep-vs-shallow-modules lens names this file as the shallowest module in the repo.
- `01-mcp-client-deep-module.md` — the contrast: same axis, opposite verdict.
- `04-synthesize-recovery-duplication.md` — another place where a concern is duplicated across files instead of hidden in one.
