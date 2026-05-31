# NDJSON line-buffering + event reconciliation

**Industry name(s):** stream framing / delimiter-based buffering, incremental parsing; reconciliation by reverse scan
**Type:** Industry standard · Language-agnostic

> Read a chunked byte stream where JSON objects may arrive split across network boundaries, reassemble complete newline-delimited records in a string buffer, parse each, and keep state consistent by reconciling paired start/end events in place.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** NDJSON line-buffering lives in the UI band — three reader loops share the same `buf.split('\n')` + `lines.pop()` pattern: `lib/hooks/useInvestigation.ts` (investigation step 2 + step 3 consumer), `app/page.tsx` L418–L443 (feed's live monitoring stream), and `app/page.tsx` L171–L192 (feed's capture-drain helper). The bytes come in over the HTTP network boundary from the two route producers (`app/api/agent/route.ts` and `app/api/briefing/route.ts`); the framing decision (newline-delimited JSON) is set by `lib/mcp/events.ts`. The reverse-scan reconciliation for `tool_call_start`/`tool_call_end` pairs is factored into the same hook (`replaceRunningTool`, L86–L95).

```
Zoom out — where NDJSON line-buffering lives

┌─ Route handler (producer) ─────────────────────┐
│  /api/agent · /api/briefing                    │
│  send(e) = controller.enqueue(JSON.stringify(e)│
│            + '\n')                             │
└─────────────────────┬──────────────────────────┘
                      │  TCP chunks may split a line mid-byte
                      ▼
┌─ UI (consumer) ────────────────────────────────┐  ← we are here
│  ★ lib/hooks/useInvestigation.ts L184–L208 ★  │
│      reader loop · buf.split('\n') · pop()    │
│  ★ app/page.tsx L418–L443 (feed live) ★       │
│  ★ app/page.tsx L171–L192 (capture drain) ★   │
│                                                 │
│  ★ replaceRunningTool (reverse scan) L86–L95 ★│
│      (pairs tool_call_end with last running    │
│       item by toolName)                        │
│         │                                       │
│         ▼                                       │
│  setItems / setDiagnosis / setRecommendations  │
│  → React re-renders ReasoningTrace             │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you reassemble complete JSON records when network chunks can arrive with an object split across two of them? The answer is a string `buf` that persists across `reader.read()` iterations, with one invariant — after every iteration, `buf` holds at most one incomplete record. Append the decoded chunk (with `{ stream: true }` so multi-byte UTF-8 doesn't get truncated), `split('\n')` on the buffer, `pop()` the last element back into `buf` (it's either empty or the next partial), and `JSON.parse` everything else. A companion reverse scan then reconciles `tool_call_end` events with the matching earlier `tool_call_start` items in React state. The next sections trace exactly what happens to `buf` across two chunks when a `tool_call_start` lands split in the middle.

---

## How it works

**Mental model — the buffer as a sliding window over the byte stream.**

A string variable `buf` accumulates decoded text across iterations. On each chunk, you append to `buf`, then split on `\n`. The split result is an array where every element except the last is a complete record (it ended before a `\n`). The last element may be empty (the chunk ended exactly on `\n`) or a partial record still in flight. You keep that last element in `buf` and parse everything else.

```
┌─────────────────────────────────────────────────────────────────┐
│  buf (string, persists across reader.read() iterations)         │
│                                                                 │
│  iteration N:  buf = prev_partial + decoded_chunk_N             │
│                                                                 │
│  after split('\n'):                                             │
│  ┌──────────────┬──────────────┬──────────────────────────┐    │
│  │ complete[0]  │ complete[1]  │ partial (last element)   │    │
│  └──────────────┴──────────────┴──────────────────────────┘    │
│         ↓              ↓                  ↓                     │
│    JSON.parse     JSON.parse        buf = partial               │
│    handleEvent    handleEvent       (held for next iter)        │
└─────────────────────────────────────────────────────────────────┘
```

The invariant: after every iteration, `buf` holds at most one incomplete JSON object. That object will be completed — or the stream ends and you flush it.

### decode with `{stream: true}`

`TextDecoder.decode(value, { stream: true })` tells the decoder that more bytes are coming. Without that flag, the decoder finalises its internal state on each call and may replace a trailing multi-byte UTF-8 sequence (e.g., a 3-byte emoji split across chunk boundaries) with the Unicode replacement character `U+FFFD`. With `{ stream: true }`, the decoder holds the incomplete byte sequence internally and emits it correctly when the remaining bytes arrive in the next chunk. For ASCII-only JSON this is invisible; for any non-ASCII content in strings (user-facing text, tool results, diagnosis copy) it is load-bearing.

```
┌────────────────────────────────────────────────────────────────┐
│  Chunk N ends with:  0xE2 0x80  (first 2 bytes of "…" U+2026) │
│                                                                │
│  stream: false → decoder emits  U+FFFD  (corrupt)             │
│  stream: true  → decoder buffers 0xE2 0x80, waits for 0xA6    │
│                                                                │
│  Chunk N+1 starts with: 0xA6 …                                │
│  stream: true  → decoder emits  "…"  (correct)                │
└────────────────────────────────────────────────────────────────┘
```

### split + `lines.pop()`

`buf.split('\n')` returns an array. `Array.prototype.pop()` removes and returns the last element. That last element is either an empty string (chunk ended with `\n`) or the start of the next object. Assigning it back to `buf` is the entire buffering mechanism — one line, no data structures, no library.

Buffer state across two chunks where an event is split:

```
┌────────────────────────────────────────────────────────────────┐
│  CHUNK 1 (decoded)                                             │
│  {"type":"reasoning_step","step":{…}}\n{"type":"tool_call_sta  │
│                                                                │
│  buf before:  ""                                               │
│  buf after decode append:                                      │
│    {"type":"reasoning_step","step":{…}}\n{"type":"tool_call_sta│
│                                                                │
│  lines = buf.split('\n')                                       │
│  ┌─────────────────────────────────────┬──────────────────┐   │
│  │ lines[0]: {"type":"reasoning_step"… │ lines[1]: partial│   │
│  └─────────────────────────────────────┴──────────────────┘   │
│                                                                │
│  buf = lines.pop()  →  {"type":"tool_call_sta                  │
│  lines = [{"type":"reasoning_step",…}]  → parsed + dispatched  │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│  CHUNK 2 (decoded)                                             │
│  rt","toolName":"fetch_metrics","agent":"diagnostic"}\n        │
│                                                                │
│  buf before:  {"type":"tool_call_sta                           │
│  buf after decode append:                                      │
│    {"type":"tool_call_start","toolName":"fetch_metrics",…}\n   │
│                                                                │
│  lines = buf.split('\n')                                       │
│  ┌──────────────────────────────────────────────────┬──────┐  │
│  │ lines[0]: {"type":"tool_call_start",…}           │  ""  │  │
│  └──────────────────────────────────────────────────┴──────┘  │
│                                                                │
│  buf = lines.pop()  →  ""   (empty — chunk ended on \n)       │
│  lines = [{"type":"tool_call_start",…}]  → parsed + dispatched │
└────────────────────────────────────────────────────────────────┘
```

### parse + dispatch

Each element in `lines` (after `pop()`) that is not blank is passed to `JSON.parse`. The result is cast to `AgentEvent` and handed to `handleEvent`. If `JSON.parse` throws, the catch block continues — malformed lines are skipped rather than crashing the loop.

After the `for (;;)` loop exits (`done === true`), any remaining content in `buf` is flushed with a final `JSON.parse` + `handleEvent`. This handles the edge case where the server closes the connection without a trailing newline.

### tool-call reconciliation

`handleEvent` maintains a `TraceItem[]` array in React state. The reconciliation problem: `tool_call_start` and `tool_call_end` are separate events, potentially separated by many other events (reasoning steps, other tool calls). When `tool_call_end` arrives, you need to find the matching `running` item without a shared identifier — only `toolName` links them.

The algorithm is a reverse scan — iterate backward through the current items array, find the last item where `kind === 'tool'` and `toolName === e.toolName` and `status === 'running'`, then mutate a shallow copy of the array at that index.

```
┌────────────────────────────────────────────────────────────────┐
│  items array at time of tool_call_end for "fetch_metrics"      │
│                                                                │
│  index  0: {kind:'step',   id:'s1', …}                        │
│  index  1: {kind:'tool',   toolName:'fetch_metrics',           │
│                            status:'running'}   ← target        │
│  index  2: {kind:'step',   id:'s2', …}                        │
│  index  3: {kind:'tool',   toolName:'analyze_trends',          │
│                            status:'running'}                   │
│                                                                │
│  reverse scan: i=3 → toolName mismatch                        │
│                i=2 → kind:'step' skip                         │
│                i=1 → match → next[1] = {...it, status:'done'}  │
│                       break                                    │
│                                                                │
│  result: index 1 updated, index 3 untouched (still running)   │
└────────────────────────────────────────────────────────────────┘
```

**Step-by-step execution trace — split-across-chunks + reconciliation.**

Setup: `buf = ""`, `items = []`.

**Step 1: reader.read() → chunk 1**

`value` (decoded with `{ stream: true }`):
```
{"type":"tool_call_start","toolName":"fetch_metrics","agent":"diagnostic"}\n{"type":"reasoning_step","step":{"id":"s1","agent":"diagn
```

`buf` before: `""`
`buf` after `buf += decode(value, { stream: true })`: the full decoded string above.

`lines = buf.split('\n')`:
- `lines[0]`: `{"type":"tool_call_start","toolName":"fetch_metrics","agent":"diagnostic"}`
- `lines[1]`: `{"type":"reasoning_step","step":{"id":"s1","agent":"diagn`

`buf = lines.pop()`: `buf` = `{"type":"reasoning_step","step":{"id":"s1","agent":"diagn`

`lines` now = `[lines[0]]`.

Loop over `lines`:
- Line 0 is non-blank → `JSON.parse` succeeds → `handleEvent({type:'tool_call_start', toolName:'fetch_metrics', …})`
- `handleEvent` hits `case 'tool_call_start'` → `setItems(prev => [...prev, {kind:'tool', id: uuid, toolName:'fetch_metrics', status:'running'}])`

`items` (after React schedules the update): `[{kind:'tool', toolName:'fetch_metrics', status:'running'}]`

**Step 2: reader.read() → chunk 2**

`value` (decoded):
```
ostic","kind":"thought","content":"checking metric gaps"}}\n{"type":"tool_call_end","toolName":"fetch_metrics","agent":"diagnostic","durationMs":320}\n
```

`buf` before: `{"type":"reasoning_step","step":{"id":"s1","agent":"diagn`
`buf` after append: `{"type":"reasoning_step","step":{"id":"s1","agent":"diagnostic","kind":"thought","content":"checking metric gaps"}}\n{"type":"tool_call_end","toolName":"fetch_metrics","agent":"diagnostic","durationMs":320}\n`

`lines = buf.split('\n')`:
- `lines[0]`: `{"type":"reasoning_step","step":{"id":"s1","agent":"diagnostic","kind":"thought","content":"checking metric gaps"}}`
- `lines[1]`: `{"type":"tool_call_end","toolName":"fetch_metrics","agent":"diagnostic","durationMs":320}`
- `lines[2]`: `""` (trailing newline)

`buf = lines.pop()`: `buf` = `""`.

`lines` now = `[lines[0], lines[1]]`.

Loop:
- Line 0: `JSON.parse` → `handleEvent({type:'reasoning_step', …})` → appends step item to `items`.
- Line 1: `JSON.parse` → `handleEvent({type:'tool_call_end', toolName:'fetch_metrics', durationMs:320})`
  - `setItems(prev => …)` functional update:
    - `next = [...prev]` (copy)
    - `i = next.length - 1` → scan backward
    - finds `{kind:'tool', toolName:'fetch_metrics', status:'running'}` at its index
    - replaces with `{…, status:'done', durationMs:320}`
    - returns `next`

`items` final: `[{kind:'tool', toolName:'fetch_metrics', status:'done', durationMs:320}, {kind:'step', id:'s1', …}]`

**The principle:** you can only frame records from a delimiter-based stream by buffering the boundary. The delimiter (`\n`) is not guaranteed to align with chunk boundaries. The buffer is the mechanism that holds the boundary region across iterations until the delimiter arrives.

---

## NDJSON line-buffering + event reconciliation — diagram

The primary data flow from byte stream to UI state.

```
┌──────────────────────────────────────────────────────────────────────┐
│  fetch('/api/agent?insightId=…')                                     │
│       │                                                              │
│       ▼                                                              │
│  res.body  ──  ReadableStream<Uint8Array>                            │
│       │                                                              │
│       ▼                                                              │
│  reader = res.body.getReader()          ← Web Streams API            │
│       │                                                              │
│  ┌────┴──────────────────────────────────────────────────────────┐   │
│  │  for (;;) loop                                                │   │
│  │                                                               │   │
│  │  { done, value } = await reader.read()                        │   │
│  │         │                                                      │   │
│  │         ▼                                                      │   │
│  │  dec.decode(value, { stream: true })   ← TextDecoder          │   │
│  │         │  (holds partial multi-byte seqs across chunks)      │   │
│  │         ▼                                                      │   │
│  │  buf += decoded_string                 ← string accumulator   │   │
│  │         │                                                      │   │
│  │         ▼                                                      │   │
│  │  lines = buf.split('\n')              ← delimiter framing     │   │
│  │         │                                                      │   │
│  │         ├─── buf = lines.pop()        ← keep trailing partial │   │
│  │         │         (may be "" or partial JSON)                  │   │
│  │         │                                                      │   │
│  │         ▼                                                      │   │
│  │  for each non-blank line in lines:                            │   │
│  │    JSON.parse(line)  ──→  AgentEvent                          │   │
│  │         │                                                      │   │
│  │         ▼                                                      │   │
│  │    handleEvent(e)                                             │   │
│  │         │                                                      │   │
│  │         ├── tool_call_start → setItems([...prev, {status:'running'}]) │
│  │         │                                                      │   │
│  │         ├── tool_call_end   → setItems(prev => {              │   │
│  │         │       next = [...prev]                              │   │
│  │         │       reverse scan for last running+toolName match  │   │
│  │         │       next[i] = {...it, status:'done'}              │   │
│  │         │       return next })                                │   │
│  │         │                                                      │   │
│  │         ├── reasoning_step  → setItems([...prev, step])       │   │
│  │         ├── diagnosis       → setDiagnosis(e.diagnosis)       │   │
│  │         ├── recommendation  → setRecommendations([...prev,…]) │   │
│  │         └── done            → setComplete(true)               │   │
│  └───────────────────────────────────────────────────────────────┘   │
│       │                                                              │
│       ▼  (after loop exits)                                          │
│  flush: if (buf.trim()) handleEvent(JSON.parse(buf))                 │
│       │                                                              │
│       ▼                                                              │
│  React state: items[], diagnosis, recommendations, complete          │
│       │                                                              │
│       ▼                                                              │
│  <ReasoningTrace items={items} />  ←  live-updating UI              │
└──────────────────────────────────────────────────────────────────────┘
```

The diagram stands alone: a chunk arrives as bytes, gets decoded as text with `{ stream: true }` to handle multi-byte boundaries, appended to `buf`, split on `\n`, the trailing partial is popped back into `buf`, every complete line is parsed and dispatched to `handleEvent`, which appends or reconciles items in React state.

---

## Implementation in codebase

**File:** `lib/hooks/useInvestigation.ts`
**Function / class:** `useInvestigation` — the reader loop inside the effect's async IIFE (L184–L208) and `handle` (L97–L151)
**Line range:** L86–L208

The reader loop:

```ts
// lib/hooks/useInvestigation.ts  L184–L208
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line) as AgentEvent);
    } catch {
      /* ignore malformed line */
    }
  }
}
if (buf.trim()) {
  try {
    handle(JSON.parse(buf) as AgentEvent);
  } catch {
    /* ignore */
  }
}
```

The hook deliberately does NOT cancel this in-flight `fetch` on effect cleanup: a `startedRef` guard (L43, L47–L48) makes the effect run its fetch exactly once per mount, so under React StrictMode's mount → cleanup → re-mount cycle, cancelling on the first cleanup — while the guard blocks the re-mount from starting a fresh fetch — left the stream aborted and the logs empty. The in-flight run is allowed to complete instead (a `setState` after unmount is a safe no-op). See the comment at L32–L36.

The tool-call reconciliation reverse scan, factored out as `replaceRunningTool` (L86–L95) and applied in the `tool_call_end` case (L118–L121):

```ts
// lib/hooks/useInvestigation.ts  L86–L95
const replaceRunningTool = (arr: TraceItem[], e: Extract<AgentEvent, { type: 'tool_call_end' }>) => {
  for (let i = arr.length - 1; i >= 0; i--) {
    const it = arr[i];
    if (it.kind === 'tool' && it.toolName === e.toolName && it.status === 'running') {
      arr[i] = { ...it, status: 'done', durationMs: e.durationMs, result: e.result, error: e.error };
      break;
    }
  }
  return arr;
};

// L118–L121
case 'tool_call_end':
  replaceRunningTool(cItems, e);                  // mutates the closure mirror for the stash
  setItems((p) => replaceRunningTool([...p], e)); // reverse-scans a fresh copy for React state
  break;
```

The reverse scan runs twice per `tool_call_end`: once against `cItems` (the plain-array mirror the hook stashes to sessionStorage on `done`) and once against a fresh `[...p]` copy inside `setItems`. Same algorithm, two targets.

**Also:** `app/page.tsx` — the feed runs its own NDJSON reader loop for the live monitoring stream at L418–L443, with the trailing `if (buf.trim())` flush at L437–L443 and the same reverse-scan reconciliation inline in its `tool_call_end` case at L347–L365. The feed's `runInvestigation` drain helper (L171–L192) uses a different framing variant — `buf.indexOf('\n')` + `buf.slice` in a `while` loop rather than `split('\n')` + `pop()` — but the same buffer-the-boundary invariant. Three reader loops total now share the pattern (the hook, the feed's live stream, the feed's capture-drain).

**GitHub links:**
- `lib/hooks/useInvestigation.ts`: https://github.com/rlynjb/blooming_insights/blob/main/lib/hooks/useInvestigation.ts#L184-L208
- `app/page.tsx` (feed live stream): https://github.com/rlynjb/blooming_insights/blob/main/app/page.tsx#L418-L443

---

## Elaborate

**Where it comes from.** Stream framing is the fundamental problem of any message-oriented protocol running over a byte-stream transport. TCP delivers bytes in order but not in message-sized units. Every protocol that carries structured messages over TCP — HTTP chunked transfer, WebSocket, gRPC, Redis RESP, PostgreSQL wire protocol — solves framing. NDJSON solves it with the simplest possible delimiter: `\n`. Each complete JSON object ends with a newline; the reader buffers until it sees one. The alternative framing strategies are length-prefix (write a 4-byte integer before each record so the reader knows exactly how many bytes to wait for) and sentinel (use a unique byte sequence that cannot appear inside a record). NDJSON's newline delimiter is human-readable and trivial to implement but requires that `\n` cannot appear unescaped inside a JSON string value — which is true by the JSON spec.

**The deeper principle.**

```
┌─────────────────────────────────────────────────────────────────┐
│  Framing strategies over a byte stream                          │
│                                                                 │
│  Strategy          │ Delimiter        │ Reader action           │
│  ──────────────────┼──────────────────┼─────────────────────── │
│  NDJSON (here)     │ \n               │ split + buffer partial  │
│  Length-prefix     │ 4-byte header    │ read N, then payload    │
│  SSE               │ \n\n             │ browser built-in        │
│  WebSocket frames  │ frame header     │ browser built-in        │
└─────────────────────────────────────────────────────────────────┘
```

**Where it breaks down.**

1. **No max-buffer guard.** If the server never writes a `\n` — due to a bug, or because it starts streaming raw prose — `buf` grows without bound for the lifetime of the request. The browser tab's memory is the only limit. A real production implementation adds `if (buf.length > MAX_BUF) { reader.cancel(); setError('stream framing error'); return; }` after the append.

2. **Reconciliation LIFO mis-pairs on concurrent tools.** The reverse scan finds the *last* `running` item with a matching `toolName`. If two calls to the same tool ran concurrently, `tool_call_end` would pair with the second one regardless of which started first. In this codebase, tools run sequentially (the agent awaits each tool before starting the next), so the LIFO scan is always correct. If the orchestration model changed to parallel tool dispatch, this would silently mis-pair results.

3. **`lines.pop() ?? ''` returns `''` on an empty array.** If `buf` were empty and the decoded chunk were also empty (a keep-alive byte with no content), `buf.split('\n')` returns `['']`, `pop()` returns `''`, and `buf` stays `''`. Harmless, but worth knowing the degenerate path.

**What to explore next.**
- `ndjson` npm package — wraps this exact loop as a `Transform` stream; useful if the pattern recurs in server-side Node code.
- `eventsource-parser` — parses the Server-Sent Events wire format, which adds `event:`, `data:`, `id:`, and `retry:` fields on top of the `\n\n` delimiter; the parsing algorithm is structurally identical to what is here.
- Backpressure via `ReadableStream.cancel()` — if `handleEvent` cannot keep up with the rate of incoming events, the browser buffers them in the network layer; a real backpressure mechanism would pause `reader.read()` until the UI catches up.

---

## Interview defense

**What they are really asking:** can you reason about byte-stream boundaries, explain why a naive `JSON.parse(chunk)` fails, and articulate the invariant that makes the buffer-and-split approach correct? At senior level: can you name the failure modes (no max-buffer guard, LIFO mis-pair on concurrent tools)?

**[mid] Q: Why does `JSON.parse(chunk)` fail on a streaming fetch response?**
A: `reader.read()` delivers whatever bytes the network layer happens to have buffered — there is no alignment to JSON or newline boundaries. A chunk can end mid-string, mid-number, or mid-key. `JSON.parse` requires a complete, valid JSON value; a partial object is a syntax error. The fix is to accumulate chunks in a string buffer and only call `JSON.parse` after you have seen the `\n` that marks the end of the NDJSON record.

**[senior] Q: Walk through what happens to `buf` when a `tool_call_start` event is split across two chunks.**

```
┌────────────────────────────────────────────────────────────────┐
│  chunk 1 decoded:  {"type":"tool_call_start","toolName":"fetch  │
│                                                                │
│  buf += chunk1  →  {"type":"tool_call_start","toolName":"fetch  │
│  lines = split('\n')  →  [ {"type":"tool_call_start",…partial ] │
│  buf = lines.pop()    →  {"type":"tool_call_start","toolName":… │
│  lines = []           →  nothing parsed this iteration         │
│                                                                │
│  chunk 2 decoded:  _metrics","agent":"diagnostic"}\n           │
│                                                                │
│  buf += chunk2  →  {"type":"tool_call_start",…,"agent":"diag…}│
│  lines = split('\n')  →  [ complete_object, "" ]               │
│  buf = lines.pop()    →  ""                                    │
│  JSON.parse(complete_object) → handleEvent → items += running  │
└────────────────────────────────────────────────────────────────┘
```

The event is recovered on the second iteration. No data is lost.

**[arch] Q: What breaks if two instances of the same tool run concurrently and both emit `tool_call_end`?**
A: The reverse scan is LIFO — it always pairs `tool_call_end` with the *last* `running` entry that matches `toolName`. If `fetch_metrics` started twice before either finished, both `tool_call_end` events would match the second (later) `running` entry. The first entry would never transition to `done`. The UI would show a permanently-spinning tool call. The fix is to add a unique `id` field to both `tool_call_start` and `tool_call_end` and scan by `id` rather than `toolName`. The current design is safe because tools are dispatched sequentially in this codebase.

**The dodge — "why hand-roll buffering instead of SSE or a parser library?"**
Honest answer: `EventSource` (browser SSE) cannot send custom request headers — `Authorization`, `x-api-key`, etc. The agent route requires an OAuth token. Moving auth to a query parameter or cookie changes the attack surface. Using `fetch` with the `Authorization` header keeps auth in the standard place. The NDJSON framing code is 6 lines; the cost of the hand-roll is low compared to the auth complexity tradeoff. If auth were cookie-based, SSE would be worth revisiting.

```
┌─────────────────────────────────────────────────────────────────────┐
│  SSE (EventSource)                 │  fetch + NDJSON (this code)    │
│  ─────────────────────────────────   ─────────────────────────────  │
│  Auth: cookies only (no headers)   │  Auth: any header              │
│  Reconnect: automatic              │  Reconnect: none               │
│  Framing: browser-native           │  Framing: 6 lines of code      │
│  Format: SSE envelope required     │  Format: raw NDJSON            │
└─────────────────────────────────────────────────────────────────────┘
```

**Anchors — cite these in your answer.**
- `lib/hooks/useInvestigation.ts` L190: `buf += dec.decode(value, { stream: true })` — the append.
- `lib/hooks/useInvestigation.ts` L191–L192: `const lines = buf.split('\n'); buf = lines.pop() ?? ''` — the invariant.
- `lib/hooks/useInvestigation.ts` L86–L95: the reverse scan, factored out as `replaceRunningTool`.
- `app/page.tsx` L426–L427: the same two lines in the feed's live monitoring stream, confirming the pattern is shared across both streaming surfaces.
- `TextDecoder` MDN: the `stream` option is documented under `TextDecodeOptions`.

---

## Validate your understanding

**Level 1 — reconstruct.** Without looking at the file, write the 6-line buffer loop: declare `buf`, call `reader.read()` in a `for (;;)`, decode with the correct option, split, pop, and loop over the remaining lines calling `JSON.parse`. Then check your version against `lib/hooks/useInvestigation.ts` L184–L201.

**Level 2 — explain.** At L151, `buf = lines.pop() ?? ''`. What does `lines.pop()` return when the chunk ends with exactly one `\n`? What does it return when the chunk ends with no `\n`? Why is the `?? ''` fallback needed, and when would `pop()` return `undefined`? (Answer: if `buf` were `""` and the decoded chunk were `""`, `"".split('\n')` returns `[""]` and `pop()` returns `""` — not `undefined`. The `?? ''` fallback triggers only if `split` somehow returned an empty array, which cannot happen for a string, so it is a defensive `null`-coalescion for TypeScript's type narrowing.)

**Level 3 — apply.** Scenario: users report that one out of every thirty-or-so investigation runs shows a missing tool call in the reasoning trace — a `tool_call_start` with no matching `done` state. A colleague suspects a chunk boundary is landing mid-object. Trace the buffer for this sequence:

```
chunk A: {"type":"tool_call_start","toolName":"query_segments","agent":
chunk B: "diagnostic"}\n{"type":"tool_call_end","toolName":"query_segm
chunk C: ents","agent":"diagnostic","durationMs":88}\n
```

Show every variable at every step: `buf` before and after each chunk, `lines`, `buf = lines.pop()`, which lines get parsed, and what `handle` does. Then identify whether the missing-tool-call bug would appear in this trace or somewhere else. Cite `lib/hooks/useInvestigation.ts` L184–L208 and L86–L121.

**Level 4 — defend.** A reviewer says: "this is reinventing SSE; just use `EventSource`." Walk through the auth constraint, the three lines of framing code that would be saved, and the reconnect behavior difference. State your conclusion without hedging.

**Quick check.**
- What is the value of `buf` after `"abc\ndef".split('\n').pop()`? (`"def"`)
- If `{ stream: true }` is omitted from `TextDecoder.decode`, what breaks and when? (multi-byte sequences split across chunk boundaries produce `U+FFFD` — only visible in non-ASCII content)
- What is the time complexity of the reverse scan in `tool_call_end`? (O(n) where n = number of items in the trace so far)
- Name the two files in this codebase that implement the `split('\n')` + `pop()` buffer loop. (`lib/hooks/useInvestigation.ts` and `app/page.tsx`)

## See also

→ ../01-system-design/05-streaming-ndjson.md · → ../01-system-design/07-client-stream-handoff.md

---
Updated: 2026-05-28 — repointed the reader-loop + reverse-scan reconciliation refs from `app/investigate/[id]/page.tsx` (now removed) to the `useInvestigation` hook (`lib/hooks/useInvestigation.ts` L184–L208, L86–L121) and the feed's own loop (`app/page.tsx` L418–L443); noted the hook's started-guard + no-cancel-on-cleanup StrictMode decision
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
