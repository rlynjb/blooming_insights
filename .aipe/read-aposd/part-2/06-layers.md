# Chapter 6 — Different layer, different abstraction

## Opener

Chapter 5 shaped one module's interface. Now we zoom out: when you stack modules into layers, each layer has to earn its place by offering something the layer below doesn't.

## The idea

**Adjacent layers should offer different abstractions.** If a function in layer N just forwards to a function in layer N+1 — same arguments, same return type, no transformation — then layer N is doing zero work. It's a **pass-through method**, and the only thing it adds is one more frame on the call stack and one more file the reader has to open.

Same goes for data: a **pass-through variable** threaded through five layers, unchanged, only used at the bottom, is the data version of the same problem.

## How it works

Two stacks side by side. Same job. One earns its layers; the other doesn't.

```
  Real layers vs pass-through layers

  ┌─ LAYERS EARN THEIR PLACE ────────────────────────────────────────┐
  │                                                                   │
  │   route handler         "stream NDJSON of an investigation"       │
  │       │                  (HTTP concern)                           │
  │       ▼                                                           │
  │   agent runner          "drive monitoring / diagnostic / etc."   │
  │       │                  (orchestration concern)                  │
  │       ▼                                                           │
  │   agent loop            "Claude + tools, multi-turn"              │
  │       │                  (model loop concern)                     │
  │       ▼                                                           │
  │   MCP client            "call a tool, cached, retried"            │
  │       │                  (transport-with-policy concern)          │
  │       ▼                                                           │
  │   transport             "bytes over HTTP to MCP"                  │
  │                          (network concern)                        │
  │                                                                   │
  │   each layer's abstraction is DIFFERENT from its neighbour's.     │
  │   you can describe each layer's job in one sentence and not       │
  │   use the layer above's vocabulary.                               │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ PASS-THROUGH STACK (bad) ───────────────────────────────────────┐
  │                                                                   │
  │   route       handleRequest(req)                                  │
  │       │       → calls agent.handleRequest(req)                    │
  │       ▼                                                           │
  │   agent       handleRequest(req)                                  │
  │       │       → calls loop.handleRequest(req)                     │
  │       ▼                                                           │
  │   loop        handleRequest(req)  ← same signature                │
  │       │       → calls client.handleRequest(req)                   │
  │       ▼                                                           │
  │   client      handleRequest(req)  ← same signature                │
  │                                                                   │
  │   four layers, all with handleRequest(req). nobody                │
  │   added an abstraction. layer added zero value.                   │
  └───────────────────────────────────────────────────────────────────┘
```

The diagnostic question is: pick a function in a layer. Describe what it does in one sentence *without* using the vocabulary of the layer above it. If you can't, the layer's not earning its place — it's just forwarding the upstairs vocabulary downstairs and adding a frame on the stack.

The pass-through *variable* is the same trap with data. If `sessionId` gets threaded through four function signatures only to be used in the fifth, the middle three layers have a parameter they don't care about. They're now coupled to a fact (session-keying) that isn't their concern.

## Why it cuts complexity

Pass-through layers maximize the *interface* count without expanding what's hidden. Recall chapter 3's value ratio: depth = functionality / interface. A pass-through layer is pure interface, no new functionality — so its depth approaches zero. Every layer that doesn't earn its place actively hurts the value ratio of the whole stack.

The cause it removes is dependency proliferation: a pass-through forces every layer to depend on the layer above's *vocabulary* (the argument shape) even though it doesn't use it. Strip the pass-through and each layer depends on only what it actually consumes. Cognitive load drops because you're not opening five files to follow one variable; change amplification drops because you can change the upper layer's signature without rippling through three layers that didn't care.

## In your code

The request-flow stack in `blooming_insights` is one of the cleanest "layers earn their place" examples in the repo. The same picture appears in `.aipe/study-system-design/01-request-flow.md` as the architectural layer diagram.

**The five layers, each offering a different abstraction:**

| layer | file | abstraction it offers |
|---|---|---|
| route handler | `app/api/agent/route.ts` | "stream NDJSON for one investigation step" — HTTP concern |
| agent driver | `lib/agents/diagnostic.ts` etc. | "run agent X with this prompt, hook into events" — orchestration |
| agent loop | `lib/agents/base.ts:runAgentLoop` | "Claude + tools, multi-turn, force final answer" — model loop |
| MCP client | `lib/mcp/client.ts:McpClient` | "tool call with cache + rate-limit + retry" — transport policy |
| transport | `lib/mcp/transport.ts:SdkTransport` | "bytes to the MCP server, capturing raw errors" — network |

Read each row's last column. None of them use the row above's vocabulary. None of them just forward. The route knows about NDJSON and the per-investigation step; the loop knows about turns and forced synthesis; the client knows about rate limits and retry hints; the transport knows about HTTP and JSON-RPC. Different abstractions at every altitude — that's a stack that's earning its layers.

**The pass-through variable that almost happened — `project_id`.** The Bloomreach MCP server demands a `project_id` on every tool call. One way to handle that would be: agent code holds `projectId`, threads it through `runAgentLoop`, threads it through `McpClient.callTool`, threads it through `SdkTransport.callTool`. Four layers all carrying the same variable. The agent loop doesn't care about project IDs — it cares about tool calls — but its signature would now depend on the fact that tool calls happen to need a project ID.

That's not what this codebase does. The `project_id` lives in the *agent's tool argument construction* (it's part of `args`, not a separate parameter), so it never appears in `runAgentLoop`'s signature. `runAgentLoop` is project-id-agnostic; the transport is project-id-agnostic; only the layer that knows what tool args mean (the agent itself) injects the project id. That's a layer that *didn't* pass through, and the result is two layers in the middle that stayed clean.

**The pass-through risk that exists — `sessionId` in the future.** The cleanup audit recommends session-keying the insights Map (`audits/cleanup-2026-06-02.md` finding #1). That fix will introduce `sessionId` as a parameter that needs to reach `putInsights` / `getInsight` / `listInsights`. The honest design question for that fix: does `sessionId` belong as a parameter on those functions, or does the `insights` module become an instance constructed with a session ID? Threading it as a parameter is the pass-through risk; constructing the module per-session is the cleaner shape. Both reduce the bug; one of them adds a parameter that several layers now have to forward.

## The red flag

**Pass-through method** — same interface as the method it calls. If `foo.handleRequest(req)` only does `return bar.handleRequest(req)`, `foo` isn't a layer; it's a typo. Related: **pass-through variable** — a parameter threaded through three or more functions and used in none of them except the deepest. Quick fix-test: try deleting the layer and inlining the call. If nothing else in the codebase breaks except the import, the layer was pass-through.

## Carry forward

Chapter 6 said each layer must offer a different abstraction. Chapter 7 sharpens the question of *which direction the complexity should flow*: when in doubt, pull it down. Better the body suffer than the callers.

**See also:**
- `.aipe/study-system-design/01-request-flow.md` — the same five-layer stack, walked from the system-design angle.
- `lib/mcp/client.ts` and `lib/mcp/transport.ts` — the policy-vs-bytes split is a clean layer boundary in this repo.
