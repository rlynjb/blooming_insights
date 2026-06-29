# Streaming

*Industry standard — server-sent token streaming · also: NDJSON event streaming*

## Zoom out — where streaming lives in this codebase

Two layers can stream: the LLM call itself (token-by-token from Anthropic) and the route-to-browser channel (NDJSON events from the agent loop). **This codebase streams the second, not the first.** The user sees the agent's *reasoning* land live in the `StatusLog` panel; what they *don't* see is the model's tokens arriving incrementally.

```
  Zoom out — what streams, what doesn't

  ┌─ Browser ────────────────────────────────────────────────┐
  │  StatusLog ← ReasoningTrace                              │
  │  consumes NDJSON via fetch() + ReadableStream reader     │
  └──────────────────────┬───────────────────────────────────┘
                         │  ★ STREAMS: AgentEvent NDJSON ★
                         │  reasoning_step, tool_call_start,
                         │  tool_call_end, insight, diagnosis,
                         │  recommendation, done, error
                         ▼
  ┌─ Route layer (app/api/agent/route.ts) ──────────────────┐
  │  emits one AgentEvent per agent step via encodeEvent()  │
  │  to the ReadableStream                                  │
  └──────────────────────┬───────────────────────────────────┘
                         │  agent.invoke()
                         ▼
  ┌─ Agent layer (AptKit reusable agent) ───────────────────┐
  │  loop: ask model → handle tool_use → ask again          │
  └──────────────────────┬───────────────────────────────────┘
                         │  DOES NOT STREAM: full completion
                         │  per call (messages.create, not stream)
                         ▼
  ┌─ Anthropic API ──────────────────────────────────────────┐
  │  full response per call                                  │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** Two streaming surfaces, one used, one deliberately not. The product reason is good: the user cares about *which queries the agent is running*, not which tokens it's writing. The NDJSON wire delivers that. Streaming raw tokens would be noise.

## Structure pass — layers · axes · seams

**Layers:** model → adapter → agent loop → route → browser.

**Axis: at what altitude do we stream?** Token altitude (model side): NO. Event altitude (loop side): YES.

**Seam:** `messages.create()` vs `messages.stream()` at `lib/agents/aptkit-adapters.ts:50`. The adapter uses the non-streaming method. If you wanted token-level streaming, this is the seam to retrofit.

## How it works

### Move 1 — the mental model

You know how a chat app like ChatGPT shows tokens appearing one-by-one? That's *token streaming* — the model streams tokens as it generates them. You can also stream at a higher altitude: emit one event per *step* in your loop. Same word ("streaming"), two different things.

```
  Two altitudes of streaming, same word

  Token streaming (NOT in this codebase):
   ─────────────────────────────────────
   model produces:  "I"   →  "I'll"  →  "I'll check"  →  "I'll check the"  →  ...
   browser sees:    "I"   →  "I'll"  →  "I'll check"  →  "I'll check the"  →  ...

   tradeoff: perceived latency drops to <1s
             but: harder to validate, harder to do structured-output mid-stream

  Event streaming (THIS codebase):
   ───────────────────────────────
   loop iter 1: { reasoning_step: "checking the workspace schema…" }    ← NDJSON line
   loop iter 2: { tool_call_start: "execute_analytics_eql" }            ← NDJSON line
   loop iter 3: { tool_call_end: durationMs:7300, result: {...} }       ← NDJSON line
   loop iter 4: { reasoning_step: "revenue dropped 38% in usa…" }       ← NDJSON line
   loop iter 5: { insight: { headline:"usa purchase_revenue · -38%" } } ← NDJSON line
   loop iter N: { done: true }                                          ← NDJSON line

   tradeoff: each event is meaningful (a step, a tool, a result)
             but: first-event latency = first-LLM-call latency
                  (no incremental tokens within a call)
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the adapter explicitly uses the non-streaming call.**

From `lib/agents/aptkit-adapters.ts:42-52`:

```typescript
async complete(request: ModelRequest): Promise<ModelResponse> {
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
                                          // ← non-streaming type
    model: this.defaultModel,
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages.map(toAnthropicMessage),
  };
  ...
  const response = await this.anthropic.messages.create(params, ...);
  //                                    ^^^^^^ not .stream()
```

The Anthropic SDK exposes both `messages.create()` and `messages.stream()`. This codebase calls the first. The full response arrives, then the loop runs again.

**Part 2 — the event stream is the route's job.**

`app/api/agent/route.ts:182-211` constructs an `AgentEvent` wire protocol and emits one event per agent step. The hooks fired by `AptKit` (`onText`, `onToolCall`, `onToolResult`) are translated to `AgentEvent`s and enqueued onto the `ReadableStream`:

```typescript
const hooksFor = (agent: AgentName) => ({
  onText: (t: string) => {
    if (t.trim()) stepFor(agent, 'thought', t);     // → 'reasoning_step' event
  },
  onToolCall: (tc: ToolCall) => send({              // → 'tool_call_start' event
    type: 'tool_call_start', toolName: tc.toolName, agent,
  }),
  onToolResult: (tc: ToolCall) => send({            // → 'tool_call_end' event
    type: 'tool_call_end', toolName: tc.toolName, agent,
    durationMs: tc.durationMs ?? 0,
    result: trunc(tc.result),
    error: tc.error,
  }),
});
```

Each `send()` writes one NDJSON line through `encodeEvent()` (`lib/mcp/events.ts:14-16`):

```typescript
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}
```

**Part 3 — the browser reads it as it arrives.**

`lib/streaming/ndjson.ts:18-65` is the shared reader. Three consumer surfaces use it: the feed (`useBriefing`), the investigation hook (`useInvestigation`), and the chat surface. All three loop the same way:

```typescript
const reader = body.getReader();
const decoder = new TextDecoder();
let buf = '';
while (true) {
  if (opts?.cancelOn?.()) { await reader.cancel(); return; }
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';                          // hold partial last line
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try { onEvent(JSON.parse(line) as E); }
    catch (err) { opts?.onMalformed?.(line, err); }
  }
}
```

**Part 4 — the cost of NOT token-streaming.**

The recommendation agent's rationale is the most-visible piece of generated text — anywhere from 50 to 300 tokens of prose. At Sonnet's generation speed (~70 tokens/sec), that's 0.7–4.5s of "the LLM is writing" time. Today, the user sees nothing until the full rationale arrives. With token streaming, they'd see the first word in <1s.

That's the trade. Worth it? Probably yes today (the per-step events already make the app feel live), but the recommendation rationale is a candidate for layered streaming — both per-step events AND per-token tokens within the synthesis step.

### Move 3 — the principle

**Pick the altitude that matches what the user cares about.** If they care about progress (which step is happening), event-stream. If they care about perceived response time on long generations, token-stream. You can do both — at the cost of more complex client code.

## Primary diagram — the full recap

```
  The two streaming surfaces in this codebase

  ┌─ NOT streamed today (would shorten first-token latency) ──┐
  │  Anthropic API ──[full response]──→ Adapter               │
  │  messages.create(), not messages.stream()                 │
  │  lib/agents/aptkit-adapters.ts:50                         │
  └────────────────────────────────────────────────────────────┘

                              ●  agent loop runs ●

  ┌─ Streamed today (live progress UI) ────────────────────────┐
  │  Route ──[AgentEvent NDJSON, line per event]──→ Browser    │
  │  encodeEvent() at lib/mcp/events.ts:14                     │
  │  readNdjson() at lib/streaming/ndjson.ts:18                │
  │                                                            │
  │  Events:                                                   │
  │    reasoning_step   ← agent's narration                    │
  │    tool_call_start  ← which EQL is about to run            │
  │    tool_call_end    ← result + duration                    │
  │    insight          ← final anomaly card                   │
  │    diagnosis        ← final diagnosis object               │
  │    recommendation   ← one per recommendation               │
  │    done             ← terminator                           │
  │    error            ← terminator-with-message              │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why NDJSON over Server-Sent Events.** Three reasons in this codebase:

  1. **POST + body works with NDJSON; SSE wants GET.** Some routes accept a payload (the diagnosis handover from step 2 to step 3 via the `diagnosis` query param). SSE constrains you to GET; NDJSON over `ReadableStream` doesn't.
  2. **Simpler client code.** No `EventSource`, no automatic reconnect logic to disable. Just `fetch() + reader + split('\n')`.
  3. **One contract for events.** The same `AgentEvent` shape ships in both the live stream and the cached replay (demo snapshot). The demo replay (`app/api/briefing/route.ts:81-152`) emits the same NDJSON lines as the live route — identical decoder, identical UI behavior.

**Why not retrofit token streaming.** Three real costs:

  1. **Structured-output parsing on partial tokens is hard.** The recommendation agent emits structured `Recommendation[]` — you'd need to parse JSON incrementally to render partial recommendations, or just stream the rationale (which IS prose).
  2. **The non-streaming path is simpler everywhere.** `await anthropic.messages.create()` returns a complete `response.usage`; the streaming path requires accumulating usage across deltas.
  3. **`AbortSignal` semantics differ slightly.** The streaming SDK uses an async iterator; cancellation requires `iterator.return()` instead of `signal.abort()`. Plumbing through the existing `signal` flow needs care.

Worth doing for the recommendation rationale specifically (see exercise). Not worth doing globally.

## Project exercises

### Exercise — Token-stream the recommendation rationale

  → **Exercise ID:** B1.5
  → **What to build:** Add a `streamComplete()` method to `AnthropicModelProviderAdapter` that uses `anthropic.messages.stream()`. Have the recommendation agent (or its synthesis turn) call `streamComplete` instead of `complete`. Route token deltas through the existing `AgentEvent` channel as a new `text_delta` event (`{ type: 'text_delta', agent: 'recommendation', delta: 'The' }`). Have `RecommendationCard` render partial text as it arrives.
  → **Why it earns its place:** the recommendation rationale is the longest piece of user-visible generated text in the app. Streaming it cuts perceived latency from ~3s to <1s. Forces you to design through the structured-output / streaming-tokens tension.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts` (add `streamComplete`), `lib/agents/recommendation.ts` (opt in), `lib/mcp/events.ts` (add `text_delta` variant to `AgentEvent`), `app/api/agent/route.ts` (route deltas), `components/investigation/RecommendationCard.tsx` (render partials), `test/` (cover stream cancellation).
  → **Done when:** opening the recommend step shows the first rationale tokens within 1s of the synthesis turn starting, the existing `'recommendation'` event still fires at end-of-stream with the full typed object, and `req.signal` cancellation cleanly aborts mid-stream.
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "Why doesn't your app stream LLM tokens?"**

Two reasons. First, the product reason: the user cares about *which queries the agent is running*, not which tokens it's writing. That's what the NDJSON event stream delivers — one event per agent step, rendered live in the `StatusLog` panel. Second, the practical reason: parsing structured outputs (`Anomaly[]`, `Recommendation[]`) on partial tokens is hard. The agent emits final typed objects, not free prose. The one exception is the recommendation rationale — that's a candidate for token-streaming because it IS prose.

*Anchor: "Event streaming is the product surface; token streaming is the candidate for recommendation rationale only."*

**Q: "How does the browser consume your NDJSON stream?"**

`fetch() + ReadableStream reader + TextDecoder + split('\n') + JSON.parse per line`. The kernel is `readNdjson()` at `lib/streaming/ndjson.ts:18`; three consumer surfaces (`useBriefing`, `useInvestigation`, the chat surface) share it. The decoder is stream-aware (`{ stream: true }`) so multi-byte UTF-8 chars at chunk boundaries don't corrupt. The trailing buffer flush at end-of-stream is a no-op in practice because producers always terminate with `\n`, but it's there for safety.

*Anchor: "One kernel, four producers, all NDJSON. The `\n` terminator is the wire contract."*

## See also

  → `01-what-an-llm-is.md` — the `messages.create()` call this file decides not to stream
  → `04-agents-and-tool-use/01-agents-vs-chains.md` — the loop whose steps become events
  → `06-production-serving/04-rate-limiting-backpressure.md` — the rate-limit story that interacts with streaming
