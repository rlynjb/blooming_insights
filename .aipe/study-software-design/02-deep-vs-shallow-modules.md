# Deep vs shallow modules

**Industry name(s):** Module depth (functionality ÷ interface size) · classitis · the deep-module principle
**Type:** Industry standard · Language-agnostic

> A module is deep when its interface is narrow relative to the behavior it hides. The deepest module in blooming insights is `McpClient` (3 methods, 172 LOC of cache + retry + spacing logic). The shallowest is `app/page.tsx` — a 817-LOC client component whose "interface" (the React render contract) is nearly as wide as its implementation. Both are real findings; one is praise, one is debt.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Module depth shows up at every layer in this repo, but the contrast is sharpest in two bands: the **MCP wrapper band** (where `McpClient` is the deepest module in the codebase, ~7 lines of public interface hiding cache + retry + spacing + error tagging) and the **UI client band** (where `app/page.tsx` is the worst shallow module — ~14 useState hooks, an inline 90-line stream parser, a 90-line demo-capture flow, and a 60-line reconnect policy, all sitting at one altitude). Read the depth question across both bands and the verdict pops.

```
Zoom out — depth ranking, by layer

┌─ UI client band ───────────────────────────────────────────────┐
│  app/page.tsx               817 LOC, ~8 concerns ★ SHALLOWEST  │ ← we are here
│  InsightCard.tsx            495 LOC (rendering-heavy, deep)    │
│  useInvestigation.ts        216 LOC (hook — middling depth)    │
└────────────────────────────────────────────────────────────────┘
┌─ Route handler band ───────────────────────────────────────────┐
│  /api/agent + /api/briefing 269 + 266 LOC (cache-replay + live │
│                             combined — middling depth)         │
└────────────────────────────────────────────────────────────────┘
┌─ Agent loop band ──────────────────────────────────────────────┐
│  runAgentLoop               1 function, 4 callers ★ DEEP       │
│    (lib/agents/base.ts)                                        │
│  MonitoringAgent · DiagnosticAgent · RecommendationAgent ·     │
│  QueryAgent                 thin wrappers around runAgentLoop  │
└────────────────────────────────────────────────────────────────┘
┌─ MCP wrapper band ─────────────────────────────────────────────┐
│  McpClient                  3 methods, 172 LOC ★ DEEPEST       │
│    callTool · listTools · constructor                          │
│  coverageFor + categories   pure module, narrow surface ★ DEEP │
└────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when you call this module, how much do you have to know? A deep module answers "very little — pass the args, get the result, the body absorbs the mess." A shallow module answers "almost everything — the interface forces you to learn the implementation before you can use it safely." `McpClient.callTool(name, args, opts?)` is the first answer; `app/page.tsx`'s JSX + 14 hooks + inline parser is the second. The next sections name *what makes the deep module deep* and *what makes the shallow module shallow*, then map both to the actual files.

---

## Structure pass

**Layers.** Two layers carry the depth question: the **public interface** (what a caller has to look at to use the module) and the **implementation** (what the module hides). Depth = ratio. A narrow interface over a fat implementation is deep; a wide interface over a thin one is shallow.

**Axis: ratio of interface surface to behavior hidden.** This is *the* APOSD axis for this concept — there's no other right one. Count the things a caller has to read (method signatures, props, exported types, behavioral invariants the docs spell out) and compare them to the lines of logic the module absorbs. Control is the wrong axis (every module decides control flow); state is the wrong axis (every module owns some state). Only ratio reveals depth.

**Seams.** One seam matters per module: the **public-interface boundary**. For `McpClient`, that seam is its three-method surface (constructor + `callTool` + `listTools`) — *all* the cache/retry/spacing complexity sits below it, invisible. For `app/page.tsx`, that seam is the React render contract plus the `useState` hooks the file exposes implicitly to itself — the "interface" is wide because the file talks to itself across 14 state variables, and any external reader has to follow that conversation to understand the JSX.

```
Structure pass — module depth

┌─ 1. LAYERS ──────────────────────────────────────────────┐
│  Public interface · Implementation                         │
│  (what callers see · what the module hides)               │
└─────────────────────────────┬────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  ratio: interface surface vs behavior hidden              │
│  narrow interface + fat body = deep                       │
│  wide interface + thin body = shallow (classitis)         │
└─────────────────────────────┬────────────────────────────┘
                              │  trace across modules
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  S1: McpClient interface       (3 methods → 172 LOC)     │
│      ratio = ~57 LOC/method ★ DEEPEST                    │
│  S2: app/page.tsx interface     (8 concerns → 817 LOC)   │
│      ratio = ~100 LOC/concern but interface is wide      │
│      because the 8 concerns ARE the interface — no       │
│      single thing hides the others                       │
└─────────────────────────────┬────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the depth ratio

You know how a good library has a tiny `import` line and you never have to look inside? `import { z } from 'zod'` — one symbol, and zod's 30,000 lines hide behind it. That's the shape: a *narrow* interface (one symbol) over a *fat* implementation (30k LOC). Depth = how big is the body divided by how wide is the doorway.

```
The depth ratio — picture

  ┌──────────────────────────────────────┐
  │           INTERFACE                  │  ← what the caller has to learn
  └──────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                          IMPLEMENTATION                                   │  ← what's hidden
  │                                                                           │
  │           a deep module: narrow on top, fat below                         │
  └──────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │                              INTERFACE                                    │  ← what the caller has to learn
  │            (matches the implementation almost line-for-line)              │
  └─────────────────────────────────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                          IMPLEMENTATION                                   │
  │              a shallow module: interface ≈ implementation                 │
  └─────────────────────────────────────────────────────────────────────────┘
```

### Move 2 — what makes the deepest module deep

**The kernel.** `McpClient.callTool(name, args, opts?)` returns `{ result, durationMs, fromCache }`. Three inputs, three outputs. That's the entire surface. Below it, four things happen — and the caller learns *none* of them.

```
McpClient.callTool — what the interface hides

  caller view (the interface):
  ┌─────────────────────────────────────────────────┐
  │  mcp.callTool(name, args, opts?) → { result }   │
  └─────────────────────┬───────────────────────────┘
                        │  what's hidden below ↓
  ┌─────────────────────▼───────────────────────────┐
  │  1. TTL cache lookup                            │  ← hidden
  │     (Map<key, {result, expiresAt}>)             │
  │  2. spacing gate (minIntervalMs sleep)          │  ← hidden
  │     (so we honor 1 req/s MCP limit)             │
  │  3. live transport call                          │  ← hidden
  │  4. retry loop with parsed Retry-After hint     │  ← hidden
  │     (or exponential backoff fallback)            │
  │  5. error tagging (McpToolError)                │  ← hidden
  │  6. write-back to cache (success only)          │  ← hidden
  └─────────────────────────────────────────────────┘

       ratio: 1 method exposed, 6 mechanics hidden
       any one of those mechanics could change and no caller would notice
```

**Why each part is load-bearing.** If you drop:
- the cache → every repeated tool call hits the rate limit
- the spacing gate → the first burst of 6 tool calls triggers the 1-per-second penalty window
- the retry loop → a single 429 from the server kills the investigation
- the error tagging → the UI shows "Unauthorized" instead of "list_projects → invalid_token"

**The shape that earns depth:** every one of those four mechanics is something the *caller would otherwise have to do*. By hiding them, the module pays for its keep. A shallow module fails this test — it forces the caller to do work the module could have done.

### Move 2 — what makes the shallowest module shallow

**The anti-kernel.** `app/page.tsx` exports `HomePage()` — one default React component. That sounds narrow. It isn't, because the *implementation* exposes 8 implicit concerns through `useState`, and the JSX (the visible interface) reads from all 14 hooks. The contract isn't "render the feed"; the contract is "render the feed AND know about all 14 of these state slots."

```
app/page.tsx — interface ≈ implementation

  the visible interface:
  ┌──────────────────────────────────────┐
  │  export default function HomePage()  │
  └──────────────────┬───────────────────┘
                     │  but the JSX (lines 478–817) reads
                     │  from ALL of these state variables
                     ▼
  ┌──────────────────────────────────────────────────────┐
  │  useState: status, insights, workspace, errorMessage, │
  │  activeQuery, demoSuffix, stepStatus, queryCount,     │
  │  traceItems, coverage, reconnecting, capturing,       │
  │  mode, ready                                          │
  │  + 1 useRef (started guard)                            │
  │  + 1 useEffect (200 lines of fetch + NDJSON loop)     │
  └──────────────────────────────────────────────────────┘
       ▲
       │  the JSX (the interface) AND the state (the implementation)
       │  are both fully visible. nothing is hidden. a caller (i.e. the
       │  reader who has to edit this file) has to learn ALL OF IT.
```

**The fix is to introduce depth where none exists.** Lift the state + effect into hooks:

```
The fix — pull complexity into hooks

  hook 1: useBriefingStream(mode)
    returns { status, insights, workspace, coverage, traceItems,
             queryCount, stepStatus, errorMessage, reconnecting }
    hides: NDJSON parse loop, demo/live switch, all stream handlers

  hook 2: useReconnectPolicy()
    returns { reconnecting, triggerReconnect }
    hides: sessionStorage guard, the regex match on error text,
           the /api/mcp/reset call, the redirect

  hook 3: useDemoCapture(insights, workspace, trace)
    returns { capturing, captureAll }
    hides: postCapture, runInvestigation, the 3-step orchestration

  the page becomes:
    export default function HomePage() {
      const briefing = useBriefingStream(mode)
      const reconnect = useReconnectPolicy()
      const capture = useDemoCapture(insights, workspace, trace)
      return <LayoutAndJSX briefing reconnect capture />
    }
       │
       └─ now the page IS narrow on top of a fat body — like McpClient.
          each hook has a small return shape and hides a fat implementation.
```

### Move 3 — the principle

Module depth is the single best predictor of how much pain a codebase will cause its next contributor. A codebase of deep modules feels easy even when it does hard things; a codebase of shallow modules feels painful even when each module is trivially small. The number to watch isn't lines of code or method count — it's the *ratio of interface surface to behavior hidden*. Drive the numerator down, drive the denominator up. That's it. That's the discipline.

---

## Primary diagram

The full depth ranking for blooming insights:

```
Depth ranking — best to worst

  DEEPEST  ▲   McpClient
           │     interface:  3 methods (callTool, listTools, ctor)
           │     hides:      cache + retry + spacing + error tagging
           │     ratio:      ~57 LOC of hidden logic per method
           │     ★ textbook deep module ★
           │
           │   runAgentLoop
           │     interface:  1 function with a typed options bag
           │     hides:      Claude tool-use loop, force-final logic,
           │                 budget enforcement, hook fan-out
           │     ratio:      4 callers, zero duplication
           │
           │   coverageFor + coverageReport (lib/agents/categories.ts)
           │     interface:  3 pure functions
           │     hides:      the entire schema-vs-checklist gate
           │
           │   McpCaller (interface alone)
           │     interface:  1 method
           │     hides:      whether McpClient or a test fake satisfies it
           │
           │   useInvestigation
           │     interface:  (id, step) → { items, diagnosis, complete, error }
           │     hides:      NDJSON parse loop, stash logic, replay handling
           │     (could be deeper — currently 216 LOC; some logic leaks out)
           │
           │   /api/briefing + /api/agent route handlers
           │     interface:  HTTP GET → NDJSON stream
           │     hides:      auth, schema bootstrap, agent orchestration
           │     (deep enough — fine)
           │
           │   InsightCard
           │     interface:  one prop (insight)
           │     hides:      a lot of inline rendering decisions
           │     (deep, but the body is 495 LOC of mostly inline CSS —
           │      a different smell; see file 07)
           │
           │   app/investigate/[id]/page.tsx
           │     interface:  one component
           │     hides:      delegates well to EvidencePanel, StatusLog,
           │                 useInvestigation — leaves only layout
           │     (much better than app/page.tsx — calm, ~225 LOC)
           │
  SHALLOW  ▼   app/page.tsx
                 interface:  the JSX reads 14 useState slots
                 hides:      almost nothing — 8 concerns at one altitude
                 ratio:      8 concerns × ~100 LOC each, all visible
                 ★ worst shallow module in the repo ★
```

---

## Implementation in codebase

### The deepest module — `lib/mcp/client.ts`

```
lib/mcp/client.ts  (lines 79–172)

  export class McpClient {
    private cache = new Map<...>();                ← hidden state
    private lastCallAt = 0;                         ← hidden state
    private minIntervalMs: number;                  ← hidden config
    private maxRetries: number;
    private retryDelayMs: number;
    private retryCeilingMs: number;

    constructor(private transport: McpTransport, opts: ClientOpts = {}) {
      this.minIntervalMs = opts.minIntervalMs ?? 200;
      this.maxRetries = opts.maxRetries ?? 3;
      this.retryDelayMs = opts.retryDelayMs ?? 10_000;
      this.retryCeilingMs = opts.retryCeilingMs ?? 20_000;
    }

    async callTool<T>(name, args, options): Promise<CallToolResult<T>> {
      // 1. cache lookup                            ← hidden mechanic
      // 2. live call (with spacing gate)           ← hidden mechanic
      // 3. retry loop with parsed retry-after      ← hidden mechanic
      // 4. cache write (success only)              ← hidden mechanic
    }

    private async liveCall(name, args) {            ← private = hidden
      // spacing sleep + transport.callTool + error tagging
    }

    async listTools() { return this.transport.listTools(); }
  }
       │
       └─ a caller writes:
            const { result, fromCache } = await mcp.callTool('list_projects', { ... })
          and knows nothing about the cache, the retry loop, the
          spacing gate, or the McpToolError wrapping. that's the
          ratio that makes this module deep.
```

**What it costs to use:** a constructor and one method call. **What's hidden:** four mechanics that would otherwise be 50+ lines at every call site.

### The shallowest module — `app/page.tsx`

```
app/page.tsx  (full file, 817 lines)

  L95–L150  STATE — fourteen useState slots, all live at the file scope
    const [status, setStatus]               = useState('loading')
    const [insights, setInsights]           = useState<Insight[]>([])
    const [workspace, setWorkspace]         = useState(undefined)
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

  L156–L256 DEMO CAPTURE — 100 lines of dev-only flow
    postCapture, runInvestigation, captureAll

  L258–L476 BIG EFFECT — 218 lines of fetch + NDJSON read + handlers
    handle() switch with 9 cases
    inline stream-reader for-loop with byte-buffer
    inline reconnect logic with sessionStorage guard

  L478–L817 JSX — 339 lines that READ FROM ALL 14 STATE SLOTS
       │
       └─ every one of those 14 state slots is part of the file's
          implicit interface. the JSX has to know about every one
          to render. there's no inner module to hide any of them.
          interface = implementation. THAT is shallow.
```

**The fix (named in Move 2):** three hooks. Each hook is its own deep module — `useBriefingStream` returns ~9 fields, hides the stream loop; `useReconnectPolicy` returns 2 fields, hides the sessionStorage dance; `useDemoCapture` returns 2 fields, hides the 3-step orchestration. The page collapses to ~120 lines of layout + composition.

### A second deep example for contrast — `runAgentLoop`

```
lib/agents/base.ts  (lines 48–176)

  export async function runAgentLoop(opts: {
    anthropic, mcp, agent, system, userPrompt, toolSchemas,
    onToolCall?, onText?, onToolResult?,
    maxTurns?, maxTokens?, maxToolCalls?, synthesisInstruction?
  }): Promise<AgentRunResult>
       │
       └─ surface: ONE function. options bag is wide, but the call shape is one line.
       │
       └─ hidden:
            - Anthropic Messages.create loop turn by turn
            - tool_use block extraction
            - tool dispatch through McpCaller
            - tool_result feedback as the next user turn
            - the forceFinal trick (drop tools + append synthesis instruction
              on the last allowed turn, so the model produces JSON)
            - tool-call budget enforcement (maxToolCalls)
            - graceful termination (maxTurns exhausted → returns '')
       │
       └─ four callers use it:
            - MonitoringAgent.scan          (lib/agents/monitoring.ts L88)
            - DiagnosticAgent.investigate   (lib/agents/diagnostic.ts L51)
            - RecommendationAgent.propose   (lib/agents/recommendation.ts L46)
            - QueryAgent.answer             (lib/agents/query.ts L30)
          NONE of the four has to know how the loop works internally.
          they pass a prompt + a tool subset + hooks and read the finalText.
```

This is the second-deepest module in the repo. The four agent classes are *thin* by design — they're tiny wrappers that build the system prompt, filter the tool subset, and call the loop. That's what depth looks like at the next layer up.

---

## Elaborate

The opposite of a deep module is what Ousterhout calls *classitis* — the dogma that every small thing should be its own class. blooming insights has one near-miss: the four agent classes (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`) could be functions instead of classes, since each one has only the constructor + one public method. Calling `new DiagnosticAgent(anthropic, mcp, schema, allTools).investigate(anomaly, hooks)` vs `diagnose({ anthropic, mcp, schema, allTools, anomaly, hooks })` is a wash on cognitive load, but the class shape adds construct-then-call ceremony for no information-hiding payoff. Not a bug; a small judgment call. The classes earn their keep weakly — by holding the constructor args once instead of threading them through every method — but only the agent that has *one* method gets little from that.

The deeper lesson: depth is the right *frame*, but it's not always the right *fix*. If a piece of code has genuinely co-equal independent parts, forcing it into a deep module makes you invent fake abstractions. The page component's eight concerns are coupled enough that three hooks is the right split — but trying to collapse them into one deep "useFeed" hook with 14 return values would just move the shallowness inside. Pick the seams that *actually* hide unrelated knowledge.

## Interview defense

**Q: How do you measure module depth without just counting lines?**
A: I look at the ratio between two things: the surface a caller has to read (method count, prop count, exported types, behavioral invariants the docs spell out — the "API surface") and the lines of logic the module absorbs that the caller *doesn't* have to know. `McpClient` exposes three methods and absorbs 172 lines of cache + retry + spacing logic — high ratio, deep. `app/page.tsx` exports one component but the JSX reads 14 state slots and 8 concerns — low ratio (interface ≈ implementation), shallow. The number isn't the metric; the *gap* between numerator and denominator is.

**Q: What's the worst shallow module in this codebase and how would you fix it?**
A: `app/page.tsx`, 817 lines, eight unrelated concerns at one altitude (rendering, NDJSON stream parsing, reconnect policy, demo capture, mode toggle, coverage accumulation, trace accumulation, stepper-state derivation). I'd extract three hooks: `useBriefingStream(mode)` for the fetch + NDJSON loop, `useReconnectPolicy()` for the sessionStorage-guarded auto-reconnect, and `useDemoCapture(insights, workspace, trace)` for the dev-only capture orchestration. The page collapses to ~120 lines of layout + composition; each hook becomes its own deep module with a small return shape hiding a fat body.

```
Interview-defense diagram — the depth fix for app/page.tsx

  before:
  ┌─ app/page.tsx (817 LOC) ─────────────────────┐
  │ 14 useState · NDJSON loop · capture flow ·    │
  │ reconnect policy · stepper derivation · JSX   │
  └───────────────────────────────────────────────┘

  after:
  ┌─ app/page.tsx (~120 LOC) ────────────────────┐
  │   layout + composition                        │
  └─┬────────┬────────┬───────────────────────────┘
    │        │        │
    ▼        ▼        ▼
  useBrief   useRec   useDemoCapture
  Stream     onnect   (dev-only)
  (~150)     Policy   (~80)
             (~30)
```

## Validate

1. **Reconstruct.** Without opening the file: what's the depth ratio of `McpClient` (surface methods vs hidden mechanics)? What four mechanics does `callTool` hide?

2. **Explain.** Why is the agent → MCP boundary (`McpCaller` interface in `lib/agents/base.ts` L16–L22) named as deep, when it's only a one-method interface? What's it hiding?

3. **Apply.** Look at `lib/hooks/useInvestigation.ts` (216 LOC, returns `{ items, diagnosis, recommendations, complete, error }`). Is it deep or shallow? Ratio it: surface vs hidden mechanics. (Hint: it's middling — the return shape is narrow but the file leaks the NDJSON parse loop and the stash logic out into its caller's mental model.)

4. **Defend.** Someone says "let's break `McpClient` into three classes — `McpCache`, `McpRateLimiter`, `McpTransportAdapter` — for testability." Argue against. (Hint: invoke the depth ratio; argue that the three split classes would force every caller to compose them, widening the interface and shrinking each hidden body — classitis. The test seam is already met by injecting `McpTransport`.)

## See also

- `01-complexity-in-this-codebase.md` — `app/page.tsx` reappears there as the cognitive-load hotspot.
- `03-information-hiding-and-leakage.md` — `McpClient` reappears as a strong info-hiding example.
- `05-pull-complexity-downward.md` — explains why the cache TTL knob is exposed but the spacing interval isn't (the depth-vs-config tradeoff).
- `08-red-flags-audit.md` — "shallow module" and "classitis" red flags are scored against this audit.
