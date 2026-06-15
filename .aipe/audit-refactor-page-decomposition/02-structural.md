# Chapter 02 — Structural

Structural refactors change where the boundaries are: Extract Module, Move Function across module borders, introduce a layer where there was none, invert a dependency that points the wrong way. They're the techniques you reach for when the file is fine internally but the *file itself* is the wrong unit. In this codebase the structural moves that matter for the feed-page decomposition aren't inside the feed page — they're around it. **The NDJSON parser is the headline.** The route-level test seam is the silent partner. Both have to land before any hook extraction can ship safely.

## Map of the territory

- **DEEP — Extract Module (`parseNdjsonStream<T>` into `lib/streaming/ndjson.ts`).** The load-bearing structural seam in this notebook. Four call sites, one kernel. Precondition A.
- **DEEP — Module Boundary (the `runInvestigation(deps)` seam for route-level integration tests).** Precondition B from the audit. Reframed here as a structural opinion: the route handler's orchestration is currently un-modular because dependencies are imported at module top instead of injected.
- **BRIEF — Move Function (`monitoringState`, `monitoringSub` → `components/shared/ProcessStepper.ts`).** Two pure functions used in exactly one JSX site each. Live in the page; belong in the component module they serve.
- **BRIEF — Extract Module (the demo-capture orchestration → `lib/dev/capture.ts`).** The audit framed this as a hook; the underlying primitive is an orchestration module, with the hook as a thin React wrapper. Both layers earn extraction.
- **MENTION** — Extract Module on `stashInsights` + `useInvestigation`'s `stashKey` / `diagHandoffKey` into `lib/state/stash.ts`. Already named in Chapter 01 under Move Function.
- **NOT FOUND** — Layer introduction. The codebase has three clean layers already (UI client → route handlers → lib agents/mcp). The structural problem is intra-layer (inside the UI band), not inter-layer.

---

### Extract Module — `parseNdjsonStream<T>` into `lib/streaming/ndjson.ts` (DEEP)

**Where it shows up.** The same NDJSON line-reader kernel is written four times across the codebase. The cleanup audit (`#24 NEW`) named it explicitly:

```
The four call sites of the duplicated kernel

  ┌─ UI client band ───────────────────────────────────────────────┐
  │                                                                  │
  │  app/page.tsx:181-203          (demo-capture path)              │
  │    reader / decoder / buf / split / try-parse-or-skip            │
  │      → drains for { type: 'done' } or { type: 'error' }          │
  │      → trailing buffer dropped (no flush)                        │
  │      → no reader.cancel()                                        │
  │                                                                  │
  │  app/page.tsx:323-464          (main briefing effect)            │
  │    reader / decoder / buf / split / try-parse-or-skip            │
  │      → drains into a 9-case handle() switch                      │
  │      → trailing buffer FLUSHED                                   │
  │      → reader.cancel() on cleanup                                │
  │                                                                  │
  │  lib/hooks/useInvestigation.ts:184-208                          │
  │    reader / decoder / buf / split / try-parse-or-skip            │
  │      → drains into a handle() switch over AgentEvent            │
  │      → trailing buffer FLUSHED                                   │
  │      → no reader.cancel() (deliberate; see useInvestigation.ts:31)│
  │                                                                  │
  │  components/chat/StreamingResponse.tsx:107-132                  │
  │    reader / decoder / buf / split / try-parse-or-skip            │
  │      → drains for streamed text chunks                          │
  │      → trailing buffer handling: not re-verified                 │
  │                                                                  │
  └─────────────────────────────────────────────────────────────────┘
```

Each copy is ~25 LOC of the same shape: `reader = body.getReader()`, `decoder = new TextDecoder()`, `buf = ''`, while loop, `decode({stream: true})`, `buf.split('\n')`, `buf = lines.pop() ?? ''`, `try { JSON.parse(line) } catch { skip }`. The four copies already drift in three real axes: trailing-buffer flushing (3 of 4 flush; the demo-capture path silently drops), `reader.cancel()` on cleanup (only the briefing path does it; useInvestigation deliberately doesn't), and the type of the parsed event (`BriefingEvent` vs `AgentEvent` vs text chunks).

**Why it's like this.** Reconstructable: the first copy was written for `useInvestigation` (the calm sibling). The second was written for the briefing effect when the page added streaming. The third was written for the demo-capture flow when the snapshot pipeline needed to drain its own NDJSON. The fourth was written for `StreamingResponse` when the free-form query box landed. Each one was written by someone who had the kernel in mental cache from the previous one — close enough to feel familiar, far enough to be subtly different. Drift is the signature of write-by-recall rather than write-by-extract.

**Take.** Extract it. This is the cleanest structural refactor in the book, and the one that changes the difficulty class of every other extraction. The right shape is an async generator over typed events:

```
The kernel as an async generator — the proposed shape

  lib/streaming/ndjson.ts

  /** Drain an NDJSON ReadableStream as typed events.
   *  - decodes UTF-8 with {stream: true} to survive multi-byte splits
   *  - splits on '\n', keeps the partial trailing line for the next chunk
   *  - flushes the trailing buffer after the stream closes
   *  - silently skips malformed lines (one bad line shouldn't kill the stream)
   *  - does NOT call reader.cancel() — caller owns cancellation policy */
  export async function* parseNdjsonStream<E>(
    body: ReadableStream<Uint8Array>
  ): AsyncGenerator<E, void, void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try { yield JSON.parse(line) as E }
        catch { /* swallow malformed line — server may recover */ }
      }
    }
    if (buf.trim()) {
      try { yield JSON.parse(buf) as E }
      catch { /* ignore trailing partial */ }
    }
  }
```

Each call site collapses to a `for await ... of` loop:

```
After extraction — the four call sites

  app/page.tsx:323                  (main briefing effect, after extraction)
    for await (const evt of parseNdjsonStream<BriefingEvent>(res.body)) {
      if (cancelled) return
      handle(evt)
    }

  app/page.tsx:181                  (demo-capture path, after extraction)
    for await (const evt of parseNdjsonStream<{type?: string; message?: string}>(res.body)) {
      if (evt.type === 'done') return { ok: true }
      if (evt.type === 'error') return { ok: false, error: String(evt.message ?? 'error') }
    }
    return { ok: false, error: 'stream ended without done' }

  lib/hooks/useInvestigation.ts:184  (investigate hook, after extraction)
    for await (const evt of parseNdjsonStream<AgentEvent>(res.body)) {
      handle(evt)
    }

  components/chat/StreamingResponse.tsx:107
    for await (const evt of parseNdjsonStream<...>(res.body)) {
      // ...
    }
```

Four call sites collapse to four lines (plus the handle function each one passes to). ~100 LOC removed from the four files combined. The kernel lives once. The drift retires.

**Why this is the load-bearing refactor.** The page extraction (Chapter 01's headline) cannot ship safely without this. Here's why: if you extract `useBriefingStream` without first extracting the parser, the new hook contains the parser kernel inside its body. That's fine — until you also want to extract `useInvestigation` to share the same kernel, or you discover a parser bug in one site and fix it in two. The lift-without-precondition couples wire-format-parsing with React-state-projection inside one new hook. **Extract the parser first; then the hook is a pure projection refactor.** State management and wire-format parsing are different concerns; the precondition makes them different modules.

The cleanup audit's plan calls this out explicitly: "Don't do #8 before #24; the four-copy drift is what makes #8 unsafe." This chapter agrees. The structural seam is the precondition, not an optimization.

**The tradeoff.** Cost of doing it: one new module (`lib/streaming/ndjson.ts`, ~25 LOC of body + ~25 LOC of JSDoc + tests). One new test file (`lib/streaming/ndjson.test.ts`). Four call sites updated. ~100 LOC removed across four files. Net change is roughly zero in LOC but a 4:1 reduction in places-the-kernel-lives. Cost of not doing it: the four copies continue to drift; the next NDJSON consumer (likely a new analytics surface or a re-enabled query box) becomes a fifth copy; the next bug in the kernel (UTF-8 boundary, partial trailing line, malformed-line policy) bites in four files independently.

The breakpoint where the calculus flips: today, with four copies. The audit promoted this from a half-mention to its own finding when the re-count showed four sites instead of two. That promotion is the breakpoint announcing itself; the lift is the answer.

**What I'd watch for.** Three subtleties the async-generator shape looks like it handles but might not.

1. **`reader.cancel()` policy.** The current call sites disagree. The main briefing effect cancels on cleanup (L442-L443); `useInvestigation` deliberately doesn't (per the comment at L31-L36); the demo-capture path doesn't either. The async-generator shape PUSHES the cancellation decision to the caller — which is correct, but it's a real semantic change for the demo-capture path. Decision: the kernel doesn't cancel; the caller owns the policy. Document this in the JSDoc. Test it explicitly in the integration test.

2. **The async-generator's interplay with React StrictMode.** `useInvestigation` survives StrictMode via a `startedRef` latch. The async generator itself is StrictMode-neutral — it doesn't care about React's lifecycle. But the *consumer* (the `for await` loop inside the hook) is inside `useEffect`, and that effect runs twice in StrictMode dev. The latch pattern must be preserved at the call site, not moved into the kernel. Test: run the integration test under StrictMode (enable `React.StrictMode` in the test wrapper) and assert the agent route is hit exactly once. If you don't write this test, this is the bug that bites three weeks later.

3. **Trailing-line behavior under server-side abort.** The kernel flushes the trailing buffer after the stream closes. If the server aborts mid-line (network error, route timeout, AbortController on the server side), the trailing buffer is partial JSON. The try-catch swallows it. The four call sites today disagree on whether to surface that as an error or eat it silently. The kernel eats it silently; the caller can opt into stricter behavior by inspecting `body.cancel()` reason or by adding a `strictTrailing: boolean` option to the kernel later. Don't add the option preemptively; document the current behavior and let the first caller that needs strict mode add the option then.

**Verdict.** Worth doing — and gating every hook extraction on this landing first. Ship in its own session per the cleanup audit's hard rule about not batching refactors. The contract test asserts: yields each `\n`-terminated JSON line; flushes the trailing buffer if non-empty; skips malformed lines; survives UTF-8 multi-byte splits across `read()` chunks. Write that test; ship the module; then update the four call sites in four separate commits.

---

### Module Boundary — `runInvestigation(deps)` for route-level integration tests (DEEP)

**Where it shows up.** `app/api/agent/route.ts` and `app/api/briefing/route.ts` import their concrete dependencies at the module top: `Anthropic`, `connectMcp`, the four agent classes, schema providers. The GET handler reads request params, constructs the dependencies, and orchestrates the agent flow inline. There's no module seam between "wire concrete dependencies" and "run the orchestration." The route IS the orchestration.

This is the structural shape that prevents precondition B from being a test scaffold rather than a partial rewrite. The cleanup audit (`#15 No route-level integration tests`) names this as the second precondition for the page.tsx refactor. The eval-substrate notebook covers it for the eval gap; this notebook covers it for the page extraction.

**Why it's like this.** Reconstructable: routes started as four-line handlers (`GET → fetch from MCP → return JSON`) and grew when the orchestration got real. The lib/ layer evolved with dependency injection as the discipline (`runAgentLoop(opts)`, `new McpClient(transport, opts)`, `new DiagnosticAgent(anthropic, mcp, schema, allTools)`). The route layer accreted orchestration faster than the DI discipline could follow — by the time the orchestration was 200 LOC, the seam was already entangled with the framework entry point.

**Take.** Extract `runInvestigation(deps: { anthropic, mcp, schemaProvider, sessionId, insight, ... }): AsyncIterable<AgentEvent>` from `app/api/agent/route.ts` into `lib/agents/runInvestigation.ts`. The GET handler becomes a thin wrapper: read params, build deps via `connectMcp()`, call `runInvestigation(deps)`, pipe its AsyncIterable into the NDJSON Response body. Same shape on the briefing side: extract `runBriefing(deps)` from `app/api/briefing/route.ts`.

The page extraction depends on this because the integration test from precondition B has to mount the feed page, fire a request, and assert "stream events flow into UI state correctly." With the route's orchestration inlined into the handler, the test has to mock at the network level (MSW, undici interceptor, etc) which is high-friction. With the orchestration extracted, the test can fake at the `runBriefing(deps)` seam: the fake yields a sequence of `BriefingEvent` objects, the route's thin wrapper pipes them, and the page's `useBriefingStream` receives them. Lower-friction, faster tests, deterministic.

**The tradeoff.** Cost of doing it: two new modules (`runBriefing.ts`, `runInvestigation.ts`), two route handlers thinned to ~15 LOC each, one new dependency type per module. Cost of not doing it: the integration test has to mock at the network layer, which is slower (real fetch round-trips), flakier (timing-dependent), and tests the wrong seam (it tests Next.js's request handling, not the page's stream consumption).

Worth naming: the eval-substrate notebook (Chapter 02 DEEP section) makes this exact same argument for a different reason — the eval harness wants the same seam. **One extraction unlocks two consumers (page-extraction integration tests AND eval harness).** That's the leverage; that's why both notebooks land on the same prescription.

**What I'd watch for.** Two failure modes.

1. **The deps bag grows into a config dumping ground.** `runInvestigation` has to accept anthropic, mcp, schemaProvider, sessionId, insight, agentEventEmitter, and probably 2-3 more. At >7 fields the deps bag is too wide. Solution: introduce a `RunInvestigationDeps` type alias up front; treat it as the seam's contract; don't add fields without a comment explaining why.

2. **The AsyncIterable shape conflicts with the streaming response API.** Next.js 16's streaming response wants a `ReadableStream<Uint8Array>`, not an `AsyncIterable<AgentEvent>`. The thin route wrapper has to bridge the two — `for await (const event of runInvestigation(deps)) { writer.write(encoder.encode(JSON.stringify(event) + '\n')) }`. Standard pattern; write it once in a `lib/streaming/ndjsonResponse.ts` helper and reuse across both routes. Pair this with the Extract Module from above and you get a structural symmetry: `parseNdjsonStream<E>` on the client, `ndjsonResponse(events)` on the server. Both kernels, one module file.

**Verdict.** Worth doing — gates precondition B; unlocked by it; ships in its own session. The audit names this as `fix-later #15` with M effort; the book agrees and adds: ship it AFTER the NDJSON kernel module so the route's thin wrapper can use the same helper. Two structural moves, one ordering: `lib/streaming/ndjson.ts` → `lib/streaming/ndjsonResponse.ts` → `runInvestigation(deps)` / `runBriefing(deps)` → integration test scaffold → then the four hook extractions.

---

### Move Function — `monitoringState`, `monitoringSub` → `ProcessStepper` (BRIEF)

**Where it shows up.** `page.tsx:44-64`. Two pure functions: `monitoringState(status)` returns a `StepState` ('active' | 'error' | 'complete'); `monitoringSub(status, statusText, queryCount, insightCount)` returns the human-readable sub-line for the stepper. Both are used in exactly one place: the `<ProcessStepper monitoring={{...}} />` call at L561-L568.

**Take.** Move both into `components/shared/ProcessStepper.tsx` (or a sibling `processStepperHelpers.ts`). The functions exist to compute the props that `ProcessStepper` consumes; their natural owner is the stepper module, not the page. After the move, the page's call site becomes `<ProcessStepper monitoring={monitoringPropsFromStatus(status, stepStatus, queryCount, insights.length)} />` or similar. Two functions cease to be page-scoped; the stepper module owns its own input-shaping. Verdict: worth doing during the Extract Variable pass from Chapter 01; same session, same commit. No standalone work.

---

### Extract Module — demo-capture orchestration → `lib/dev/capture.ts` (BRIEF)

**Where it shows up.** `page.tsx:156-256` — the three functions `postCapture`, `runInvestigation`, `captureAll` plus the regex (`AUTH_RE`) at L208. The hook lift (`useDemoCapture`) names the hook but doesn't name the underlying module. The hook is the React-state wrapper; the module is the orchestration primitive.

**Take.** Extract `runFullDemoCapture(deps: { insights, workspace, trace, onProgress }): Promise<CaptureResult>` into `lib/dev/capture.ts`. The hook `useDemoCapture` becomes a thin React wrapper: hold the `capturing` state, call `runFullDemoCapture(deps)`, update state on progress/completion. Same shape as the route-handler extraction above — pure orchestration in lib/, thin React wrapper in hooks/. Verdict: worth doing in the same session as the `useDemoCapture` extraction; ship the lib/ module first, then the hook that consumes it. Two-file lift, four sessions of separation from the page extraction (it's last in the ordered list per Chapter 01).

---

### Mentions

- **Extract Module on stash helpers.** `stashInsights` from `page.tsx:70-77`, `stashKey`/`diagHandoffKey` from `useInvestigation.ts:18-19` — all session-storage key helpers. Move to `lib/state/stash.ts`. Already noted in Chapter 01 under Move Function. Do once.

- **The `BriefingEvent` type at `page.tsx:29-38`** lives at the page level but is the wire-format type for `/api/briefing`. It belongs in `lib/mcp/events.ts` next to `AgentEvent`. Move it during the precondition A session — when you extract `parseNdjsonStream<E>`, the type parameter wants a wire-format type module that already owns both unions.

---

## Chapter close

The pattern that emerges from this chapter: the structural problems aren't intra-file (extract a function out of a function) — they're inter-file (extract a module out of a page). The feed page violates structural discipline at three boundaries: it owns a wire-format parser that should live in `lib/streaming/`, it owns a dev orchestration that should live in `lib/dev/`, and it imports types that should live in `lib/mcp/`. Each is a structural seam that already wants to exist; the file just hasn't admitted it yet.

The chapter's load-bearing claim: **the structural lifts come first, the hook lifts come second.** Precondition A (`parseNdjsonStream`) and the route-extraction precondition B (`runInvestigation(deps)`) change the difficulty class of the page extraction. Without them, the hook lift is three structural lifts in one diff. With them, it's one state-management lift with structural support already in place. The cleanup audit names this ordering explicitly; this chapter argues why it matters in catalog terms.

The other through-line: the eval-substrate notebook arrived at the same structural seam (`runInvestigation(deps)`) from a different through-line (the eval harness wants the same seam). **Two notebooks, one prescription.** That's the strongest signal in the codebase that this is the structural move worth doing — when two independent audits both name the same extraction as their precondition, the extraction is doing more than either audit credits it for. Ship it once; both use cases get the seam.
