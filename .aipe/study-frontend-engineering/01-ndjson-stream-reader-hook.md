# NDJSON Stream-Reader Hook

**Industry names:** newline-delimited-JSON streaming (NDJSON), `fetch`-`ReadableStream` reader pattern, async iterator over chunked HTTP. **Type:** Industry-standard pattern, project-specific kernel.

## Zoom out, then zoom in

You already know `fetch().then(r => r.json())` — open a request, wait for it to finish, parse the body, render. That works when the answer arrives in one shot. This product can't work that way. A monitoring agent run takes 30-90 seconds. Render-when-done means a 30-90s blank screen, and the whole pitch — "an analyst that shows its work" — collapses into "an analyst that doesn't load."

So the network seam is different. The response body is a `ReadableStream`. The hook reads chunks as they arrive, parses each `\n`-terminated JSON line into a typed `AgentEvent`, and calls `setState` per event. The UI animates from the first reasoning step that lands (~200ms) all the way through the final `done` event.

```
  Zoom out — where the NDJSON kernel lives in the system

  ┌─ UI layer (browser, client SPA) ──────────────────────────────┐
  │  app/page.tsx           app/investigate/[id]/page.tsx          │
  │       │ uses                  │ uses                            │
  │       ▼                       ▼                                 │
  │  useBriefingStream       useInvestigation                       │
  │  StreamingResponse       useDemoCapture                         │
  │       │       │              │       │                          │
  │       └───────┴──────┬───────┴───────┘                          │
  │                      ▼                                          │
  │       ★ lib/streaming/ndjson.ts — readNdjson<E>() ★             │ ← we are here
  │                      │                                          │
  └──────────────────────┼──────────────────────────────────────────┘
                         │  HTTP/1.1 chunked, content-type ndjson
  ┌─ Service layer (Next.js Route Handlers) ──────────────────────┐
  │  GET /api/briefing        GET /api/agent                       │
  │  → ReadableStream writes JSON.stringify(evt) + '\n' per event  │
  └────────────────────────────────────────────────────────────────┘
```

The kernel is **64 LOC** at `lib/streaming/ndjson.ts`. Every consumer is one of: a hook that owns useState slots and a `switch (evt.type)` dispatcher, or a component that does the same thing inline.

Zoom in: the pattern is "fetch → reader → TextDecoder → split('\n') → JSON.parse → onEvent, with a cancel poll between reads." It's not exotic — it's the pattern any team that picks NDJSON over SSE will write. What's interesting is the *kernel-plus-five-consumers* shape: the kernel was extracted *after* four duplicates already existed, so you can read the original duplication and the consolidation side by side.

## Structure pass

Three layers, one axis — **who owns the lifetime of a stream chunk?** — traced down the stack.

**Layer 1: the consumer hook.** Owns: which fetch URL, which event types matter, which `useState` slots to update, which closure mirror to write so the `done` event can stash a complete object. Lifetime question: who decides when to stop? Answer: the **consumer** does — it owns the `cancelOn` predicate (a ref it can flip true) and decides whether to cancel on cleanup at all.

**Layer 2: the kernel** (`lib/streaming/ndjson.ts`). Owns: the read loop, the buffer, the line split, the `JSON.parse`, the malformed-line policy, the trailing-tail flush. Lifetime question: who decides when to stop? Answer: it **defers** to the consumer's `cancelOn` and to the stream's natural `done` signal. The kernel reads exactly what's there and stops when told.

**Layer 3: the route handler** (`app/api/{briefing,agent}/route.ts`). Owns: when to emit each event, when to close the stream. Lifetime question: who decides when to stop? Answer: the **producer** — when the agent loop's `done` event lands or an error throws.

**The seam.** Layers 1 and 2 meet at `readNdjson<E>(body, onEvent, opts)`. The contract is small and load-bearing:

```
  Seam between kernel and consumer — what flips across it

  ┌─ Kernel side ────────────────┐  ┌─ Consumer side ───────────────┐
  │ doesn't know the event shape │  │ knows E = AgentEvent          │
  │ doesn't hold any state       │  │ holds all the useState slots  │
  │ doesn't decide what to render│  │ owns the dispatcher + render  │
  │ doesn't know about React     │  │ owns React lifecycle          │
  │     │                        │  │     │                         │
  │     └────── readNdjson<E>(body, onEvent, { cancelOn }) ──────┘
  │                              │  │                               │
  │ control flow: a while loop   │  │ control flow: React effect    │
  │ state: a ~100-byte string buf│  │ state: 5 useState + closure   │
  │ failure: silent skip + log   │  │ failure: setError → render    │
  └──────────────────────────────┘  └───────────────────────────────┘

  The kernel knows nothing about your app; your app knows nothing
  about TextDecoder. That's the line.
```

If you collapsed the kernel into the hook (or vice versa), you'd lose two things: (1) the third / fourth / fifth consumer would re-implement the trailing-buffer flush and the malformed-line policy and probably get them wrong, and (2) testing the parse loop would require mounting React.

## How it works

The mental model first, then the walkthrough.

### Move 1 — the mental model

You know how `fetch().then(r => r.json())` blocks until the whole body arrives and then hands you a parsed object? `fetch().then(r => r.body.getReader())` hands you a `ReadableStreamDefaultReader` *immediately* — and from then on, `await reader.read()` resolves every time a chunk arrives. The pattern: keep a string buffer, append each decoded chunk, split on `\n`, parse each complete line, save the last (possibly partial) piece for next time.

```
  The kernel shape — one loop, one buffer, one split

   chunks arrive
       ↓
   ┌──────────┐  decode +  ┌──────────┐  split('\n')   ┌──────────┐
   │  reader  │ ─────────► │  buffer  │ ──────────────►│ parsed   │ → onEvent
   │  .read() │   append   │  string  │  buf = lines.  │ events   │
   └──────────┘            └──────────┘  pop() ?? ''   └──────────┘
       ▲                                       │
       └──── while not done & not cancelOn ────┘

  the buffer holds the trailing partial line between reads —
  that's the part most hand-rolled versions forget
```

The most failure-prone part of the pattern is the "trailing partial line" — a chunk boundary may land mid-event, and you can't `JSON.parse` half a line. The fix is one line: `buf = lines.pop() ?? ''` (`ndjson.ts:41`) — pop the last element back into the buffer; the next chunk's append will complete it.

### Move 2 — the step-by-step walkthrough

#### The kernel — 64 LOC at `lib/streaming/ndjson.ts`

Here's the full thing, side by side with what each part does.

```ts
// lib/streaming/ndjson.ts:17-64
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
  opts?: {
    cancelOn?: () => boolean;
    onMalformed?: (line: string, err: unknown) => void;
  },
): Promise<void> {
  const reader = body.getReader();         // (1) take ownership of the stream
  const decoder = new TextDecoder();       // (2) bytes → utf-8 string, stateful
  let buf = '';
  try {
    while (true) {
      if (opts?.cancelOn?.()) {            // (3) consumer wants out — cancel
        await reader.cancel();             //     and exit before the next read
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;                     // (4) producer closed the stream
      buf += decoder.decode(value, { stream: true }); // (5) stream:true holds
                                                       //     mid-codepoint bytes
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';             // (6) the magic line — partial tail
                                           //     goes back into the buffer
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as E);  // (7) hand the event to the consumer
        } catch (err) {
          opts?.onMalformed?.(line, err);  // (8) skip malformed — default silent
        }
      }
    }
    // (9) flush trailing buffer — a no-op when the producer always terminates
    //     with '\n', kept for the case where it doesn't
    const tail = buf.trim();
    if (tail) {
      try { onEvent(JSON.parse(tail) as E); }
      catch (err) { opts?.onMalformed?.(tail, err); }
    }
  } finally {
    reader.releaseLock();                  // (10) always release the reader lock
  }
}
```

Reading it line by line:

**(1) `body.getReader()` — claim the stream.** A `ReadableStream` can only be read by one reader at a time; calling `getReader` locks it. The `finally` block at (10) releases that lock so nothing else gets stuck.

**(2) `new TextDecoder()` — stateful UTF-8 decoder.** This is critical and easy to get wrong. A UTF-8 character can be 1-4 bytes; a chunk boundary may split it. Constructing `TextDecoder` once and calling `.decode(value, { stream: true })` lets it hold partial bytes between calls — the alternative (`new TextDecoder().decode(value)` per chunk) corrupts non-ASCII content silently.

**(3) `cancelOn` — the cooperative cancel hook.** Polled at the top of each loop iteration. If the consumer flips a ref true (e.g. a `useBriefingStream` cleanup function flips `cancelledRef.current = true`), the kernel `reader.cancel()`s and exits. This is *cooperative* cancellation: the consumer asks, the kernel obeys at the next safe point. Compared to AbortSignal, this is intentionally simpler — no controller, no event listener, just a function the consumer owns.

**(4) `done` — the producer closed the stream.** Normal termination. The `break` falls through to (9).

**(5) `decoder.decode(value, { stream: true })` — append bytes as text.** The `{ stream: true }` flag is the load-bearing detail. Without it, multi-byte characters at chunk boundaries become `�` replacement characters.

**(6) `buf = lines.pop() ?? ''` — the partial-line handler.** This is the load-bearing line in the whole kernel. `split('\n')` on `"foo\nbar\nbaz"` returns `["foo", "bar", "baz"]`; on `"foo\nbar\nba"` it returns `["foo", "bar", "ba"]`. In the second case, `"ba"` is a partial line — it must NOT be `JSON.parse`d. `pop()` returns `"ba"` and removes it from the array; the loop processes `["foo", "bar"]` and the next chunk's `decoder.decode` appends to `"ba"`, completing it.

**(7) `JSON.parse(line) as E` — typed by the caller.** The kernel is generic in `E`. The consumer specifies `readNdjson<AgentEvent>(...)` (in `useInvestigation.ts:194`) or `readNdjson<BriefingEvent>(...)` (in `useBriefingStream.ts:288`); the kernel doesn't know or care what's inside.

**(8) `onMalformed` — the policy hook.** A `JSON.parse` throw means a bad line. The kernel's default is *silent skip* — log nothing, drop the line, keep reading. Loud failure would terminate the stream mid-run. The consumer can pass `onMalformed` to log; in practice none of the four consumers do, because the route handlers always emit valid JSON.

**(9) Trailing-buffer flush.** When the producer terminates events with `\n` (which all four route handlers do), the buffer is empty when `done` arrives — this block is a no-op. Kept for the case where a future producer omits the terminal newline; one extra branch costs nothing.

**(10) `releaseLock()` in `finally`.** Whether the loop exits via `cancel`, `done`, or an exception thrown by `onEvent`, the lock is released. Without this, a thrown event handler would leave the stream permanently locked.

What breaks if you remove each part:

| remove this | what breaks |
|-------------|-------------|
| `cancelOn` poll | StrictMode re-mount can leave two concurrent readers alive; mode-toggle stays stuck on the old run |
| `TextDecoder` `{ stream: true }` | non-ASCII characters at chunk boundaries become `�` |
| `buf = lines.pop()` | partial lines hit `JSON.parse`, throw, fall through to `onMalformed`, get dropped — random events go missing |
| `try { onEvent } catch onMalformed` | one bad event from the producer crashes the whole consumer |
| `finally releaseLock` | a throwing event handler leaves the body locked; subsequent `getReader()` calls reject |

Kernel done. Skeleton complete. Everything else is **hardening on the consumer side.**

#### The consumer (`useInvestigation`), side by side with what each part does

The largest consumer (`lib/hooks/useInvestigation.ts`, 202 LOC) is the canonical shape. Let's walk the load-bearing parts.

**The 5 useState slots plus the closure mirror.** Why both?

```ts
// lib/hooks/useInvestigation.ts:39-43, 66-68
export function useInvestigation(id, step): InvestigationState {
  const [items, setItems] = useState<TraceItem[]>([]);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    // ...
    const cItems: TraceItem[] = [];         // ← closure mirror of `items`
    let cDiag: Diagnosis | null = null;     // ← closure mirror of `diagnosis`
    const cRecs: Recommendation[] = [];     // ← closure mirror of `recommendations`
```

The React state is what the UI renders. The closure mirrors are what the **stash gets serialized from** when `done` arrives:

```ts
// lib/hooks/useInvestigation.ts:131-143
case 'done':
  setComplete(true);
  try {
    sessionStorage.setItem(
      stashKey(step, id),
      JSON.stringify({ items: cItems, diagnosis: cDiag, recommendations: cRecs }),
    );
    if (step === 'diagnose' && cDiag) {
      sessionStorage.setItem(diagHandoffKey(id), JSON.stringify({ diagnosis: cDiag }));
    }
  } catch { /* stash is best-effort */ }
  break;
```

If the stash read from `items` / `diagnosis` / `recommendations` (the React state) inside the event handler, it could read **stale values** — setState is async, batched, and not guaranteed to have flushed before `done` arrives. The closure mirrors are updated **synchronously** at each event arm (e.g. `cDiag = e.diagnosis` at L124, `cRecs.push(...)` at L128), so by the time `done` lands, the mirrors are a complete record of everything seen. That's what gets stashed; the React state is for rendering.

**The StrictMode survival pattern.** React 19 with `reactStrictMode: true` (Next default) mounts effects, runs cleanup, then re-mounts in dev. Without a guard, each route load would open two concurrent agent runs.

```ts
// lib/hooks/useInvestigation.ts:44, 46-49
const startedRef = useRef(false);
useEffect(() => {
  if (!id) return;
  if (startedRef.current) return;   // ← run once per mount; the re-mount bails
  startedRef.current = true;
```

The latch prevents the second mount from opening a fetch. Then — and this is the surprising part — the cleanup function is **empty**. The comment block at L33-37 explains why:

> we deliberately do NOT cancel the fetch on effect cleanup. React StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first cleanup, with the started-guard blocking the re-mount, aborted the stream and left the logs empty. The started-guard prevents a double fetch; the in-flight run simply completes (setState after unmount is a safe no-op).

This is a real tradeoff (see lens 8.3 of `audit.md`) — a user who navigates away mid-run leaves the agent running in the background until completion. The team accepted it because the alternative (a more elaborate "is this a real unmount?" detector) doesn't exist in React's public API.

**The dispatcher.** A 6-case `switch` (`useInvestigation.ts:98-152`), with two tricky arms:

```ts
case 'tool_call_start': {
  const it: TraceItem = { kind: 'tool', id: crypto.randomUUID(), toolName: e.toolName,
                           status: 'running', ts: Date.now() };
  cItems.push(it);                 // mirror update — synchronous
  setItems((p) => [...p, it]);     // React update — async
  break;
}
case 'tool_call_end':
  replaceRunningTool(cItems, e);            // mirror update — synchronous
  setItems((p) => replaceRunningTool([...p], e));  // React update — async
  break;
```

`replaceRunningTool` walks backward from the tail looking for the most recent `running` tool item with a matching `toolName` and flips it to `done` with the duration / result / error. The mirror update is in-place; the React update clones first. The pair-update pattern is repeated for every event arm.

**The mode-aware URL builder** (`useInvestigation.ts:154-178`). On a live run, the hook reads `localStorage.getItem('bi:mode')`, maps legacy values, and appends `&live=1&mode=<mode>`. It also pulls the stashed insight from `sessionStorage` and appends it as `&insight=<encoded>` — because on Vercel the feed and the investigation request can hit different serverless instances, and the browser is the only reliable carrier for the cross-instance handoff. (See lens 2 of `audit.md` for the full handoff map.)

**The 401 / OAuth dance** (`useInvestigation.ts:181-186`). Before the body is even read, the response status is checked. If it's 401 and the body carries `{ needsAuth, authUrl }`, the hook does `window.location.href = authUrl` — full-page navigation to the OAuth start. The browser's auth flow finishes by redirecting to a callback that lands the user back on the page, and the hook's `useEffect` re-runs naturally.

#### The two other consumers — same shape, different events

`useBriefingStream.ts` (313 LOC, `lib/hooks/useBriefingStream.ts`) is the larger sibling — 9 useState slots, 9 event-type dispatcher, plus a `cancelledRef` that IS polled in `readNdjson`'s `cancelOn` (the briefing supports mode-toggling mid-stream; investigation doesn't, so investigation skips this). The kernel call site:

```ts
// lib/hooks/useBriefingStream.ts:288
await readNdjson<BriefingEvent>(res.body, handle, { cancelOn: () => cancelledRef.current });
```

`useDemoCapture.ts` (146 LOC, `lib/hooks/useDemoCapture.ts:84-87`) uses the kernel for its watch-the-stream-until-done shape:

```ts
let result: { ok: boolean; error?: string } = { ok: false, error: 'stream ended without done' };
await readNdjson<{ type?: string; message?: string }>(res.body, (evt) => {
  if (evt.type === 'done') result = { ok: true };
  else if (evt.type === 'error') result = { ok: false, error: String(evt.message ?? 'error') };
});
return result;
```

The minimal consumer: no React state, no useEffect — just a closure variable mutated inside the event callback, returned after the kernel returns.

`StreamingResponse.tsx` (253 LOC, `components/chat/StreamingResponse.tsx:108`) is the chat-style consumer: 4-case dispatcher, special-cases `agent === 'coordinator' && stepKind === 'conclusion'` as "the final answer" and pulls it out into a separate `useState<string>`.

#### Layers-and-hops — one event from agent loop to pixel

```
  Layers-and-hops — what travels and which direction

  ┌─ Browser ──────────┐  hop 1: GET /api/agent?step=diagnose       ┌─ Edge ────┐
  │  useInvestigation  │ ──────────────────────────────────────────► │  Vercel   │
  │  setItems(...)     │                                              │  Function │
  │     ▲              │                                              └─────┬─────┘
  └─────┼──────────────┘                                            hop 2  │
        │ hop 7: setState fires, React reconciles, paint                  │ runs
        │                                                                  ▼
  ┌─────┴──────────────┐  hop 6: onEvent(parsed)             ┌─ Service layer ──┐
  │  readNdjson kernel │ ◄──────────────────────────────────│  diagnostic.ts   │
  │  buf.split('\n')   │  hop 5: chunk arrives               │  runAgentLoop()  │
  │  JSON.parse(line)  │ ◄──────────────────────────────────│       │           │
  └────────────────────┘  hop 4: '\n'-terminated bytes       │       │ tool call │
                                                              │       ▼           │
                                                              │  MCP server      │
                                                              │       │           │
                                                              │       │ hop 3     │
                                                              │       ▼           │
                                                              │  Bloomreach EQL  │
                                                              └──────────────────┘
```

Hop 5 is where the streaming changes everything: instead of one big response after hop 3 completes, each agent step (each `reasoning_step`, each `tool_call_start`, each `tool_call_end`) is encoded and flushed independently. The browser sees the first `reasoning_step` at ~200ms — long before the diagnostic is done.

### Move 3 — the principle

The pattern that generalizes: **when the result takes longer than the user's patience budget, treat the response body as a sequence, not a value.** The transport (NDJSON over HTTP), the kernel shape (read → decode → split → parse → onEvent), and the consumer shape (closure mirror + React state pair) compose together — but the deepest principle is the first one. Once you commit to streaming, every other decision in this guide follows: no React Query (no cache for a stream), no Suspense (no single fallback for a sequence), no SSR (you can't pre-render a stream-driven UI), progressive composition over single-state skeletons (see `02`).

## Primary diagram

Everything Move 2 walked, in one frame.

```
  The full picture — NDJSON kernel + consumer pair

  ┌─ UI layer (browser) ─────────────────────────────────────────────────────┐
  │                                                                          │
  │  React render                                                            │
  │       ▲                                                                  │
  │       │ setState per event (5 slots for investigation)                   │
  │       │                                                                  │
  │  ┌────┴───────── consumer (useInvestigation) ────────────────────────┐   │
  │  │  startedRef latch  →  StrictMode survival                          │   │
  │  │  sessionStorage stash check  →  hydrate-from-cache fast path       │   │
  │  │  closure mirrors (cItems / cDiag / cRecs) — sync record for stash  │   │
  │  │  URL builder reads bi:mode + bi:insight:<id>                       │   │
  │  │  fetch(url) → 401? OAuth redirect : await readNdjson(res.body,…)   │   │
  │  │  6-case switch (reasoning_step | tool_call_start | tool_call_end | │   │
  │  │                  diagnosis | recommendation | done | error)        │   │
  │  └────┬───────────────────────────────────────────────────────────────┘   │
  │       │                                                                  │
  │       │ onEvent(parsedEvent)                                             │
  │       │                                                                  │
  │  ┌────┴────── kernel (readNdjson, 64 LOC) ────────────────────────────┐  │
  │  │  reader = body.getReader()                                          │  │
  │  │  while (true):                                                      │  │
  │  │    if cancelOn() → reader.cancel(); return                          │  │
  │  │    { value, done } = await reader.read()                            │  │
  │  │    if done → break                                                  │  │
  │  │    buf += decoder.decode(value, { stream: true })                   │  │
  │  │    lines = buf.split('\n');  buf = lines.pop() ?? ''                │  │
  │  │    for each line: try JSON.parse → onEvent ; catch → onMalformed    │  │
  │  │  flush trailing tail                                                │  │
  │  │  finally reader.releaseLock()                                       │  │
  │  └────┬───────────────────────────────────────────────────────────────┘  │
  │       │                                                                  │
  └───────┼──────────────────────────────────────────────────────────────────┘
          │  HTTP/1.1 chunked, Content-Type: application/x-ndjson (or similar)
  ┌───────┼──────────────────────────────────────────────────────────────────┐
  │       ▼   Service layer (Next.js Route Handler)                          │
  │  GET /api/agent  →  new Response(new ReadableStream({ start(controller){ │
  │     runAgentLoop({ onEvent: (e) => controller.enqueue(encodeEvent(e)) }) │
  │  }}))                                                                    │
  │  encodeEvent(e) = TextEncoder.encode(JSON.stringify(e) + '\n')           │
  └──────────────────────────────────────────────────────────────────────────┘

  The kernel knows nothing about agents or events.
  The consumer knows nothing about TextDecoder or chunk boundaries.
  The route knows nothing about React.
  Each layer can change without touching the others.
```

## Elaborate

NDJSON is older than the modern streaming-AI world — it has been the de facto format for log shipping (Fluentd, Vector), bulk data export (Elasticsearch, MongoDB), and inter-process pipes for years. The pattern your hook implements is the same one a Fluentd output plugin implements when it tails a file. What's new is using it as the client-server contract for an interactive UI.

The alternative that didn't win here is **Server-Sent Events (SSE)**. SSE is purpose-built for this — `EventSource` in the browser, automatic reconnection, a standardized `data: ...\n\n` wire format. The team chose `fetch` + `ReadableStream` over `EventSource` for three reasons:

1. `EventSource` doesn't allow custom request headers (no `Authorization: Bearer ...`)
2. `EventSource` is GET-only — POST bodies aren't supported
3. `EventSource` auto-reconnects on its own schedule, which would fight `useReconnectPolicy`'s one-shot guard

WebSockets were never on the table — they're full-duplex, and the agent → UI stream is one-way; the bidirectional plumbing would be pure cost.

The pattern most adjacent in your portfolio is **AdvntrCue's streaming chat** (per `me.md`'s system-design portfolio). That uses the same conceptual shape (Vercel serverless + streaming response + browser stream consumer) but with `streamText` from the Vercel AI SDK — which wraps a similar `fetch + reader` loop under a friendlier API. The trade is: the SDK gives you a hook (`useChat`) at the cost of locking into one wire format and one event shape. NDJSON here is the unwrapped version of that same pattern; you control every byte.

What to read next: `02-progressive-skeleton-with-stepper.md` covers how the events the kernel delivers actually become visible UI — the skeleton-sized-like-the-result trick that holds layout steady while the dispatcher fires.

## Interview defense

**Q: Walk me through how you stream agent reasoning to the browser.**

Open with the picture, not the definition. "Three layers — a Next.js route opens a `ReadableStream` and writes one JSON event per line; a 64-LOC kernel in `lib/streaming/ndjson.ts` reads the body, splits on `\n`, and calls a typed `onEvent` per event; a React hook owns the `useState` slots and a `switch` that maps event types to state updates. The whole thing is `fetch + ReadableStream + TextDecoder`, no SDK, no library."

```
  whiteboard sketch

  fetch ──► reader.read() ──► decode + buf ──► split('\n')
                                                    │
                                             pop() trailing
                                             partial line
                                                    │
                                                    ▼
                                            JSON.parse → onEvent
                                                    │
                                                    ▼
                                              setState per event
```

Then name the load-bearing parts: "The partial-line handler — `buf = lines.pop() ?? ''` — is the one most hand-rolled versions get wrong. The `TextDecoder` constructed once with `{ stream: true }` keeps UTF-8 codepoints intact across chunks. Cooperative cancellation via a `cancelOn` predicate the consumer owns."

**Q: Why NDJSON instead of SSE?**

"Three reasons. SSE's `EventSource` doesn't allow `Authorization` headers, doesn't allow POST, and auto-reconnects on its own schedule — which would fight our one-shot reconnect guard for the Bloomreach OAuth flow. The unwrapped `fetch + ReadableStream` gives us all that control. The wire format is JSON-per-line; the routing is whatever HTTP gives us."

**Q: How do you handle React StrictMode? Most stream hooks have bugs there.**

"A `startedRef` latch on the first effect run prevents the re-mount from opening a second fetch. The cleanup function is deliberately empty — I tried cancelling the fetch on cleanup, but with the latch blocking the re-mount, it aborted the stream and left the logs empty. The tradeoff: a user navigating away mid-run leaves the agent running until it finishes. Setstate after unmount is a safe no-op. I documented this with the rationale at the top of the hook."

```
  the StrictMode dance

  mount 1     ─► effect runs   ─► startedRef = true, opens fetch
  cleanup 1   ─► (no cancel)
  mount 2     ─► effect runs   ─► startedRef === true, bail
  fetch from mount 1 finishes  ─► setStates flush into mount-2 React tree
```

**Q: Why is the closure mirror separate from the React state?**

"Because `setState` is async. When the `done` event arrives, I want to stash a complete object into sessionStorage so the next visit hydrates instantly. If I read `items` from the React state inside the event handler, I might get a stale snapshot. The closure mirror — `cItems`, `cDiag`, `cRecs` — is updated synchronously as each event arrives, so by the time `done` fires, it's a complete record. React state is for rendering; the mirror is for serialization."

**Q: What if a malformed line comes through?**

"The kernel's default is silent skip — `JSON.parse` throws, the `onMalformed` callback fires, the loop continues to the next line. Loud failure would terminate the stream mid-run, which is worse than dropping one event. The consumer can pass `onMalformed` to log; in practice ours don't, because the route handlers always emit valid JSON."

## See also

- `00-overview.md` — the network seam diagram + the three highest-leverage patterns
- `02-progressive-skeleton-with-stepper.md` — how the events this kernel delivers become visible UI
- `audit.md` lens 1 (rendering & reactivity), lens 4 (data-fetching & cache), lens 8.3 (the deliberate non-cancel tradeoff)
- `study-networking` (sibling guide) — HTTP chunked transfer, `EventSource` vs `fetch+ReadableStream` tradeoffs in depth
- `study-runtime-systems` (sibling guide) — what happens under `await reader.read()` in the event loop
- `study-software-design` (sibling guide) — `useInvestigation` as an Ousterhout deep module (5-field result interface hides the dispatcher + closure mirror + StrictMode latch)
