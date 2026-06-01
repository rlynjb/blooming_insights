# Layers and abstractions

**Industry name(s):** Pass-through methods · pass-through variables · "layer not earning its place" · over-abstraction
**Type:** Industry standard · Language-agnostic

> Every layer in a stack has to carry its own weight. A layer that just forwards what's above it without adding anything — pass-through methods, mirror-shaped wrappers — wastes the reader's time and accumulates as a "where is this defined?" tax. The bad news: blooming insights has one clear pass-through (`McpClient.listTools`). The interesting news: most boundaries DO earn their place — the route ↔ agent layer, the agent ↔ McpClient layer, the McpClient ↔ transport layer each transform what passes through them.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The codebase has four real layers (UI → route → agent → MCP wrapper → transport), and each is followed by a question: *does this layer add anything?* For three of the four, the answer is yes — the route adds NDJSON framing + cache-replay; the agent adds prompts + tool subset + validation; McpClient adds cache + retry + spacing. The fourth — McpClient → transport — is mostly load-bearing too, but it has one method (`listTools`) that does nothing but forward. Tiny finding, but it's the cleanest pass-through example in the repo.

```
Zoom out — what each layer adds

┌─ UI layer ─────────────────────────────────────────────────────┐
│  app/page.tsx  · adds: rendering, mode toggle, NDJSON parsing  │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTP / NDJSON
┌─ Route layer ────────────▼─────────────────────────────────────┐
│  /api/briefing  · adds: schema bootstrap + coverage gate +      │
│                          NDJSON framing + demo replay           │
│  /api/agent     · adds: anomaly resolution + cache replay +     │
│                          step routing                            │
│  → earns its place clearly                                      │
└──────────────────────────┬─────────────────────────────────────┘
                           │ runAgentLoop(opts)
┌─ Agent layer ────────────▼─────────────────────────────────────┐
│  MonitoringAgent · adds: prompt + monitoringTools subset +      │
│                          AnomalyArray validation + sort + slice │
│  → earns its place                                              │
└──────────────────────────┬─────────────────────────────────────┘
                           │ mcp.callTool(...)
┌─ Wrapper layer ──────────▼─────────────────────────────────────┐
│  McpClient · adds: cache + retry + spacing + error tagging     │
│            · BUT listTools() is a literal pass-through ★        │  ← we are here
└──────────────────────────┬─────────────────────────────────────┘
                           │ transport.callTool / transport.listTools
┌─ Transport layer ────────▼─────────────────────────────────────┐
│  SdkTransport · adds: HTTP error body capture + McpToolError   │
│  → earns its place via the error-body capture                  │
└────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when you trace a call from the top of the stack to the bottom, does each layer transform what passes through it, or does it just shuffle the same data across a boundary? Pass-throughs are the smell — the layer is acting as a polite hallway rather than a doorway with a lock. The next sections walk three real call chains in this repo and ask, at each layer, "what did this layer add?"

---

## Structure pass

**Layers.** Six bands in the call chain for a single tool execution: caller (agent) → `McpCaller` interface → `McpClient.callTool` → `liveCall` → `McpTransport` interface → `SdkTransport.callTool` → vendor SDK. That's a lot of layers for one call. The question is whether each one earns its place.

**Axis: transformation.** What does each layer transform about the call as it passes through? This is the right axis because pass-throughs are *literally* the question of whether a layer transforms. Control is too coarse (every layer "decides" something trivially); state ownership repeats what file 03 covered. Trace transformation across the six layers and the load-bearing seams pop — and so do the cosmetic ones.

**Seams.** Three transforming seams (load-bearing), one pass-through seam (the smell). **Transforming #1: caller → McpClient.** The caller passes `name + args`; the wrapper adds cache lookup, spacing, retry, and an enriched return shape (`{ result, durationMs, fromCache }`). **Transforming #2: McpClient → SdkTransport.** The wrapper passes through the same name + args, but the transport wraps `client.callTool` with HTTP error body capture, so a 401 surfaces with the real server text instead of "Unauthorized." **Transforming #3: route → agent.** The route passes a prompt + tool subset + hooks; the agent runs the loop and returns a validated, sorted, sliced result. **Pass-through #1: McpClient.listTools → transport.listTools.** Literally one line: `return this.transport.listTools();`. No cache, no spacing, no transform. The layer is empty here.

```
Structure pass — what each seam transforms

┌─ 1. LAYERS ──────────────────────────────────────────────┐
│  Caller · McpCaller · McpClient · McpTransport ·          │
│  SdkTransport · vendor SDK                                │
└─────────────────────────────┬────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  transformation: what does this layer ADD as the call     │
│  passes through?                                          │
└─────────────────────────────┬────────────────────────────┘
                              │  trace across seams
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  S1: caller → McpClient.callTool ★ TRANSFORMS HEAVILY    │
│      (adds cache + retry + spacing + return enrichment)  │
│  S2: McpClient.callTool → SdkTransport.callTool ★ TRANS  │
│      (adds HTTP error body capture)                       │
│  S3: route → agent ★ TRANSFORMS                          │
│      (prompt + tool subset + validation + sort/slice)    │
│  S4: McpClient.listTools → transport.listTools           │
│      ★ PASS-THROUGH (no transform) — the only one        │
└─────────────────────────────┬────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the pass-through shape

You know how a React component that *only* forwards its props down (`<Wrapper {...props}>`) sometimes earns nothing — you could delete it and use the inner component directly? That's the pattern. A pass-through is a layer whose body is "call the next layer with the same args, return its result, do nothing else." It's not wrong by definition — sometimes the layer exists for *future* transformation, or for the seam itself (mockability). But each pass-through deserves a "why is this here" justification, and the default answer should be "delete it."

```
Pass-through vs transforming layer

  TRANSFORMING                     PASS-THROUGH
  ┌─ caller ──────┐                ┌─ caller ──────┐
  │ asks for X    │                │ asks for X    │
  └───────┬───────┘                └───────┬───────┘
          │                                │
          ▼                                ▼
  ┌─ layer ───────┐                ┌─ layer ───────┐
  │ wraps X with: │                │ return        │  ← does nothing
  │ - cache       │                │   next(X)     │
  │ - retry       │                └───────┬───────┘
  │ - logging     │                        │
  └───────┬───────┘                        ▼
          │                        ┌─ next layer ──┐
          ▼                        │ does the work │
  ┌─ next layer ──┐                └───────────────┘
  │ does the work │
  └───────────────┘
```

### Move 2 — the one real pass-through in the repo

**The kernel: `McpClient.listTools`.** One line, no transform.

```
The pass-through

  McpClient.listTools()
    return this.transport.listTools()    ← that's it
       │
       │
       └─ no cache (intentional — tools list is read once at startup)
       └─ no spacing (intentional — listTools doesn't count against the rate limit)
       └─ no retry (intentional — failures here are fatal anyway)
       └─ no error tagging (the SdkTransport wraps errors itself)

  the layer ADDS nothing. callers could call transport.listTools() directly
  and the behavior would be identical.
```

**Why it's still here (and probably should stay):** `McpClient` is the single object the rest of the codebase imports for MCP work. If callers had to import both `McpClient` (for calls) AND `McpTransport` (for listing tools), the surface would widen — that's a small leak. The pass-through is a small cost paid to keep one type as the MCP interface. **The justification is real but thin.** A reviewer is right to ask about it; the answer is "it's the cost of one-import-per-domain." Acceptable.

```
Why the pass-through earns a stay-of-execution

  WITHOUT the pass-through                WITH the pass-through (current)
  ┌─ route handler ──────────┐           ┌─ route handler ──────────┐
  │ import McpClient         │           │ import McpClient         │
  │ import McpTransport      │           │  (one import for all MCP) │
  │                          │           └──────────────────────────┘
  │ mcp.callTool(...)        │
  │ transport.listTools()    │           mcp.callTool(...)
  └──────────────────────────┘           mcp.listTools()
       ▲
       │  two types in the route handler's vocabulary
       │  → small leak of MCP internals upward
```

### Move 2 — the seams that DO transform (praise)

**S1: caller → McpClient.callTool.** What gets added at this boundary:

```
What McpClient.callTool transforms

  caller passes:                  caller receives:
  ┌────────────────────────┐      ┌──────────────────────────────────┐
  │ name: string           │      │ result: T                         │
  │ args: Record<string,…> │  →   │ durationMs: number  ← ADDED       │
  │ options?: { ttl, skip }│      │ fromCache: boolean  ← ADDED       │
  └────────────────────────┘      └──────────────────────────────────┘

  what the layer does between in and out:
    - cache lookup (skip the next 5 steps on hit)
    - spacing sleep (honor 1.1s gate)
    - transport.callTool() (the live call)
    - rate-limit retry loop (parsed retry-after or backoff)
    - error tagging (McpToolError wrapping)
    - cache write (success only)

  every one of those is a transform. the layer earns its place.
```

**S3: route → agent (via the agent class).** What gets added:

```
What MonitoringAgent.scan transforms

  route passes:                   route receives:
  ┌────────────────────────┐      ┌──────────────────────────────────┐
  │ hooks: MonitorHooks    │      │ Anomaly[]                         │
  │ categories: Anomaly… []│  →   │   (filtered, validated, sorted    │
  └────────────────────────┘      │    by severity, sliced to top 10) │
                                  └──────────────────────────────────┘

  what the layer does between in and out (lib/agents/monitoring.ts L69–L120):
    - builds the system prompt (PROMPT + schemaSummary + project_id + checklist)
    - filters the tool schemas (monitoringTools subset of allTools)
    - calls runAgentLoop with budgets + synthesisInstruction
    - parses the final text as JSON (parseAgentJson)
    - validates the shape (isAnomalyArray)
    - degrades gracefully on parse/validate failure ([])
    - sorts by severity rank
    - slices to top 10

  eight transforms. the layer is one of the deepest in the repo.
```

### Move 2 — a soft pass-through worth naming

**The four agent classes vs the loop they wrap.** Each agent class (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`) is essentially a thin wrapper around `runAgentLoop` + one public method. Their constructors take the same four args (`anthropic`, `mcp`, `schema`, `allTools`). Their methods all follow the same shape: build prompt → call loop → parse + validate.

```
Are the agent classes pass-through-shaped?

  for each agent:
    constructor(anthropic, mcp, schema, allTools)
    public method(input, hooks):
      const system = PROMPT.replace(...)        ← transforms
      const { finalText } = await runAgentLoop({...})
      const parsed = parseAgentJson(finalText)  ← transforms
      const validated = isXArray(parsed) ? parsed : []
      return validated.sort(...).slice(...)     ← transforms

  THIS IS NOT A PASS-THROUGH. each agent transforms in three places:
    1. system prompt build
    2. JSON validation
    3. domain-specific post-processing
```

So the agent classes earn their keep. **But** the constructor + one-method-per-class shape would also fit functions just as well (see file 02's classitis aside). That's a different smell — not a pass-through, but a "is the class shape pulling its weight?" question. Different file (02), different fix; named here for completeness.

### Move 3 — the principle

Pass-throughs are usually a symptom of one of three things: (a) the layer was added "in case we need it later" and the later never came; (b) the layer's *real* job was hidden behind a too-narrow interface that doesn't show what it transforms; or (c) the layer earns its keep through the SEAM (mockability, single-import surface) rather than through transformation. Case (c) is what saves `McpClient.listTools`. Case (a) is the one to delete. Case (b) is the one to widen.

The discipline: when you find a pass-through, write the justification line. If you can't, delete the layer.

---

## Primary diagram

Pass-throughs vs transforms across the whole stack:

```
Pass-through audit — call chain by call chain

  CALL CHAIN: "an agent runs an MCP tool"
  ──────────────────────────────────────────────────────────────────
   route ──► agent.method(input, hooks)   ★ TRANSFORMS (prompt + validation)
              │
              ├─► runAgentLoop(opts)       ★ TRANSFORMS (Anthropic loop)
              │     │
              │     └─► mcp.callTool(...)  ★ TRANSFORMS (cache+retry+spacing)
              │           │
              │           └─► transport.callTool(...)  ★ TRANSFORMS (error capture)
              │                 │
              │                 └─► client.callTool(...)  vendor SDK
              │
              └─► parseAgentJson(text)     ★ TRANSFORMS (fence + substring scan)


  CALL CHAIN: "list the MCP tools at startup"
  ──────────────────────────────────────────────────────────────────
   route ──► mcp.listTools()
              │
              └─► transport.listTools()    ★ PASS-THROUGH — no transform
                    │
                    └─► client.listTools()
                          │
                          └─► vendor SDK


  CALL CHAIN: "bootstrap the schema"
  ──────────────────────────────────────────────────────────────────
   route ──► bootstrapSchema(mcp)          ★ TRANSFORMS (sequential calls,
              │                             cached, error-throwing wrapper)
              ├─► resolveProject(mcp)       ★ TRANSFORMS (org → project picker)
              │     ├─► mcp.callTool(list_cloud_organizations)
              │     └─► mcp.callTool(list_projects)
              ├─► mcp.callTool(get_event_schema)
              ├─► mcp.callTool(get_customer_property_schema)
              ├─► mcp.callTool(list_catalogs)
              ├─► mcp.callTool(get_project_overview)
              └─► parseWorkspaceSchema(...) ★ TRANSFORMS (unwrap envelopes,
                                              normalize event schemas)
```

---

## Implementation in codebase

### The pass-through — `McpClient.listTools`

```
lib/mcp/client.ts  (lines 168–171)

  /** List the tools the connected MCP server exposes (name, description,
   *  inputSchema). Used by /debug for introspection and by agents to build the
   *  tool schemas they hand to Claude. Not cached — the tool set is stable per
   *  connection and listed rarely. */
  async listTools(): Promise<unknown> {
    return this.transport.listTools();
  }
       │
       │  one line. zero transformation. literal pass-through.
       │
       └─ the comment above it does the work that the method body doesn't:
          it explains the deliberate absence of caching/spacing/retry.
          the comment is the only justification for the method existing.
```

**Verdict:** stays, with a documented reason. Comment-as-justification is acceptable when the layer's value is "single-import surface for the domain." But if `listTools` ever needs caching (the connected server's tool set could in principle change), the wrapper is where it goes. The pass-through is also the *seam* for that future change.

### The transform — `McpClient.callTool` (for contrast)

```
lib/mcp/client.ts  (lines 97–146)

  async callTool<T>(name, args, options = {}): Promise<CallToolResult<T>> {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
    const ttl = options.cacheTtlMs ?? 60_000;

    if (!options.skipCache) {                     ← TRANSFORM 1: cache lookup
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result as T, durationMs: 0, fromCache: true };
      }
    }

    const start = Date.now();                     ← TRANSFORM 2: duration timing
    let result = await this.liveCall(name, args);

    let retries = 0;                              ← TRANSFORM 3: retry loop
    while (isRateLimited(result) && retries < this.maxRetries) {
      retries++;
      const hintMs = parseRetryAfterMs(result);
      const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
      const waitMs = Math.min(
        hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
        this.retryCeilingMs,
      );
      await sleep(waitMs);
      result = await this.liveCall(name, args);
    }

    const durationMs = Date.now() - start;

    if ((result as any)?.isError === true) {      ← TRANSFORM 4: error not cached
      return { result: result as T, durationMs, fromCache: false };
    }

    this.cache.set(cacheKey, { result, expiresAt: Date.now() + ttl });  ← TRANSFORM 5: cache write
    return { result: result as T, durationMs, fromCache: false };
  }
       │
       │  FIVE transforms in one method. that's a layer earning its place.
       │  not a single line of "return this.transport.callTool(name, args)".
       └─
```

The contrast is the audit — same file, two methods, one pass-through and one heavy transform.

### A transform at a higher altitude — `MonitoringAgent.scan`

```
lib/agents/monitoring.ts  (lines 69–120)

  async scan(hooks?: MonitorHooks, categories: AnomalyCategory[] = []): Promise<Anomaly[]> {
    const checklist = categories.length                      ← TRANSFORM 1: build checklist
      ? categories.map((c) =>
          `- \`${c.id}\` (${c.label}) — ${c.whyItMatters} ...`
        ).join('\n')
      : '(no checklist provided — scan for any significant recent change)';

    const system = PROMPT                                     ← TRANSFORM 2: build system prompt
      .replace('{schema}', schemaSummary(this.schema))
      .replace(/\{project_id\}/g, this.schema.projectId)
      .replace('{categories}', checklist);

    const { finalText } = await runAgentLoop({                ← inner call (transforms there)
      anthropic: this.anthropic,
      mcp: this.mcp,
      agent: 'monitoring',
      system,
      userPrompt: 'Work through your category checklist...',
      toolSchemas: filterToolSchemas(this.allTools, monitoringTools),  ← TRANSFORM 3: tool subset
      onToolCall: hooks?.onToolCall,
      onToolResult: hooks?.onToolResult,
      onText: hooks?.onText,
      maxTurns: 8,
      maxToolCalls: 6,
      synthesisInstruction: 'You have NO more tool calls...',
    });

    let parsed: unknown;                                      ← TRANSFORM 4: parse JSON
    try { parsed = parseAgentJson(finalText); }
    catch { return []; }
    if (!isAnomalyArray(parsed)) return [];                   ← TRANSFORM 5: validate shape
    return [...parsed]                                        ← TRANSFORM 6: sort + slice
      .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
      .slice(0, 10);
  }
       │
       └─ six transforms. the agent class is doing real work. praise.
```

---

## Elaborate

A clean codebase has a small number of pass-throughs (zero is unrealistic) and each one has a written justification. blooming insights has one pass-through with a written justification — that's a healthy ratio for a codebase this size.

Where to watch as the codebase grows: the four agent classes are *near* pass-through-shaped at the constructor/method level (one method per class, all share the same constructor signature). If a fifth or sixth agent gets added and they each still wrap `runAgentLoop` with the same prompt-build → parse → validate shape, the right move is to fold them into a single factory function that returns a `runMonitoring` / `runDiagnostic` etc., parameterized by the prompt + tool subset + validator. That's a deeper refactor than the audit lens calls for today, but it's the trajectory.

The other trajectory worth watching: if `/api/agent/route.ts` and `/api/briefing/route.ts` continue to grow, the line between "route" and "agent orchestration" will blur. Today the routes have ~30 lines of agent orchestration in each. If that grows past ~100, lifting the orchestration into a `lib/orchestrate/briefing.ts` and `lib/orchestrate/investigation.ts` would keep the routes thin and the orchestration testable. Right now they earn their place.

## Interview defense

**Q: Walk me through a pass-through in this codebase and decide whether it stays.**
A: `McpClient.listTools` (`lib/mcp/client.ts` L168–L171) is a one-liner that forwards to `transport.listTools()`. No cache, no spacing, no retry. By the strict definition it's a pass-through. The justification I'd write is "this method exists so callers import one MCP type instead of two — keeping `McpTransport` out of the route handler's vocabulary." That's a real reason, and it's documented in the comment above. It stays. The test for deletion would be: does any caller in the repo *want* the transport object directly? They don't — they all hold an `McpClient`. So the pass-through is paying for itself by keeping the import surface narrow.

**Q: How do you spot a layer that's not earning its place?**
A: Three signs. (1) The method body is one line that forwards arguments unchanged. (2) The return type matches the inner type 1:1. (3) The layer can't tell you, in one sentence, what it transforms. If a layer fails all three, it's a candidate for inlining. `listTools` fails (1) and (2) but passes (3) — it earns its keep at the import surface. The four agent classes each fail (1) and (2) but pass (3) hard — six transforms in `MonitoringAgent.scan`. That's the gradient.

```
Interview-defense diagram — pass-through test

   ┌─ method body is 1 line of forwarding? ─┐
   │   YES                                  │ NO → not pass-through
   ▼
   ┌─ return type = inner type 1:1? ────────┐
   │   YES                                  │ NO → not pass-through
   ▼
   ┌─ can you name what it transforms? ─────┐
   │   NO                                   │ YES → pass-through with reason — KEEP
   ▼
   DELETE — pass-through with no justification
```

## Validate

1. **Reconstruct.** Without opening the file: name the one literal pass-through method in `McpClient`. Why does it stay even though it does no transformation?

2. **Explain.** What FIVE transforms does `McpClient.callTool` add between the caller's `name + args` and the returned `{ result, durationMs, fromCache }`?

3. **Apply.** Look at `lib/mcp/transport.ts` (lines 47–73). `SdkTransport.callTool` and `SdkTransport.listTools` look almost identical. Is one of them a pass-through? (Hint: both wrap `client.callTool` / `client.listTools` with HTTP error body capture — they each TRANSFORM by catching the captured error body and re-throwing with the real server text. Not pass-throughs.)

4. **Defend.** Someone says "let's delete `McpClient.listTools` — callers can hold a `McpTransport` reference directly." Argue against. (Hint: argue from the import surface — the wrapper exists so callers see one MCP type. Deleting it forces every caller to depend on the transport too, widening the cognitive load.)

## See also

- `02-deep-vs-shallow-modules.md` — McpClient's depth depends on the transforms in `callTool`; the pass-through `listTools` doesn't change the depth verdict.
- `03-information-hiding-and-leakage.md` — `insightToAnomaly` is pass-through-shaped between layers (also a leak).
- `05-pull-complexity-downward.md` — the agent classes don't push knobs up; the layer pulls its weight even when thin.
- `08-red-flags-audit.md` — "pass-through method" red flag is scored.
