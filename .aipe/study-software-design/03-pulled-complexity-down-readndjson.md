# Pull complexity down — the `readNdjson` kernel

*industry name: Extract Function / lifted kernel · type: Language-agnostic (APOSD primitive)*

---

## Zoom out, then zoom in

**Zoom out — where this pattern lives.** The streaming kernel sits between the browser's `fetch()` and four different consumer surfaces that all need to read NDJSON.

```
  Zoom out — where readNdjson sits in the system

  ┌─ UI surfaces (4) ─────────────────────────────────────────┐
  │  app/page.tsx              ← briefing feed                │
  │  app/investigate/[id]/...  ← investigation pages          │
  │  components/chat/...       ← free-form Q&A streaming      │
  │  dev capture flow          ← snapshot capture             │
  └────────────────┬──────────────────────────────────────────┘
                   │  each uses one of these hooks/helpers:
                   │     • useBriefingStream     (briefing feed)
                   │     • useInvestigation      (investigation)
                   │     • useDemoCapture        (capture flow)
                   │     • StreamingResponse     (chat surface)
  ┌─ shared kernel ─▼─────────────────────────────────────────┐
  │                                                           │
  │     lib/streaming/ndjson.ts                               │  ← you are here
  │     readNdjson(body, onEvent, { cancelOn?, onMalformed? })│
  │                                                           │
  │     ONE 64-LOC implementation                             │
  │     of the fetch → reader → decoder → buffer →            │
  │     split('\\n') → JSON.parse → handle(event) loop        │
  │                                                           │
  └────────────────┬──────────────────────────────────────────┘
                   │  uses standard browser/Node API:
                   │     body.getReader() + TextDecoder
  ┌─ route stream sources ──▼─────────────────────────────────┐
  │  /api/briefing (NDJSON) · /api/agent (NDJSON)             │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** Four streaming surfaces all do the same dance: open a `fetch`, get a `ReadableStream<Uint8Array>`, decode bytes to UTF-8, accumulate a buffer, split on newlines, parse each line as JSON, dispatch to a typed handler. The first three implementations of this used to live inline in their respective hooks — same 25-line loop, three times. `readNdjson` pulled that loop down into one shared kernel; the consumers now hand it a body and an `onEvent` callback and the kernel owns everything else. **Pulling complexity down means: when the same complexity lives in N places, move it to one place that's easier to harden.**

---

## Structure pass

**Layers.** Two:

```
  consumer layer     4 streaming consumers
                     ──────────────────────
                     each has its OWN typed event vocabulary
                     (BriefingEvent | AgentEvent | …) and its OWN
                     dispatch table; passes those + a stream body
                     down

  kernel layer       lib/streaming/ndjson.ts
                     ────────────────────────
                     generic over <E>; doesn't know what events
                     exist; reads bytes, parses lines, hands each
                     parsed event back to the consumer
```

**Axis — trace one question.** *Where does a malformed line get handled?*

```
  layer              who handles a malformed JSON line?
  ─────────────      ──────────────────────────────────
  consumer layer     never sees malformed lines — kernel filters
                     them. Optional `onMalformed` callback is the
                     only way to see one (default: silent skip).
  kernel layer       inside the try/catch around JSON.parse;
                     swallow + continue (the briefing canonical
                     behavior); call onMalformed if provided.
```

The axis-answer doesn't flip — the kernel owns it end-to-end. That uniformity IS the point. Before the lift, three consumers each had their own try/catch style (one logged, one threw, one had no handler at all). After the lift, malformed-line behavior is identical for every consumer unless they explicitly opt in to observe it.

**Seams.** One horizontal seam (consumer-to-kernel). The kernel's options object (`{ cancelOn?, onMalformed? }`) is the explicit "where consumers can plug in" boundary — narrow and optional, so the typical caller is a two-line call.

---

## How it works

### Move 1 — the mental model

A pulled-down kernel is like a list rendering's `.map(item => <Row key={item.id} {...} />)` — the boilerplate of iteration lives in one well-tested operation; the per-row logic lives in the consumer. You don't write your own `for` loop every time you render a list because the iteration is solved. `readNdjson` solves stream iteration the same way: the consumer provides "what to do with one parsed event"; the kernel provides "how to get from a byte stream to a sequence of parsed events."

```
  The pulled-down kernel — many callers, one body

         consumer A                  consumer B
         ──────────                  ──────────
         hands kernel:               hands kernel:
           - ReadableStream            - ReadableStream
           - onEvent(E)                - onEvent(E)
           - cancelOn? (opt)           - cancelOn? (opt)
                │                          │
                │                          │
                └──────────┬───────────────┘
                           ▼
              ┌────────────────────────────┐
              │  readNdjson<E>(body, fn,   │
              │               opts?)       │
              │                            │
              │   while not done:          │
              │     if cancelOn() → bail   │
              │     read chunk             │
              │     buf += decode(chunk)   │
              │     lines = buf.split('\n')│
              │     buf = lines.pop()      │
              │     for line in lines:     │
              │       try fn(parse(line))  │
              │       catch onMalformed    │
              │   flush trailing buf       │
              │                            │
              └────────────────────────────┘

  one body, five callers (4 production + 1 test helper)
```

The benefit: when the trailing-buffer flush bug surfaces, you fix it in one place. When you want to add cancellation, you change one signature. When you want to add malformed-line observability, you add one optional callback. Every consumer gets the upgrade for free.

### Move 2 — the step-by-step walkthrough

#### Move 2a — the kernel itself

`lib/streaming/ndjson.ts`, 64 LOC including the header comment. The whole body:

```ts
  // lib/streaming/ndjson.ts:17-64 (annotated)
  export async function readNdjson<E>(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: E) => void,
    opts?: {
      cancelOn?: () => boolean;
      onMalformed?: (line: string, err: unknown) => void;
    },
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        if (opts?.cancelOn?.()) {                  // ← poll the consumer's
          await reader.cancel();                   //   cancellation latch
          return;                                  //   between reads
        }
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });  // ← streaming UTF-8
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';                   // ← keep the unterminated tail
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;                     // ← skip blank lines
          try {
            onEvent(JSON.parse(line) as E);
          } catch (err) {
            opts?.onMalformed?.(line, err);        // ← silent unless observed
          }
        }
      }
      // flush trailing buffer — no-op when producer always terminates with '\n'
      const tail = buf.trim();
      if (tail) {
        try {
          onEvent(JSON.parse(tail) as E);
        } catch (err) {
          opts?.onMalformed?.(tail, err);
        }
      }
    } finally {
      reader.releaseLock();                        // ← always release
    }
  }
```

**Line-by-line read of what's load-bearing:**

  - **`reader.read()` in a `while (true)` loop** — the standard `ReadableStream` consumption pattern. `done: true` breaks the loop.
  - **`buf.split('\n')` then `lines.pop()`** — the canonical streaming-NDJSON shape. A chunk doesn't necessarily end at a line boundary; whatever follows the last `\n` is incomplete and gets prepended to the next chunk via `buf`. Without `lines.pop()`, partial events at chunk boundaries would `JSON.parse` and throw.
  - **`opts?.cancelOn?.()` polled BETWEEN reads** — not preemptive cancellation (which would need an `AbortSignal` on the fetch); good enough for React-effect cleanup where the consumer just sets a ref and wants the loop to stop on its next iteration.
  - **`reader.releaseLock()` in `finally`** — required by the streams spec; locking a body twice throws. The `finally` guarantees release on cancel, error, or normal completion.
  - **The trailing-buffer flush** — handles the rare case where a producer omits the terminal `\n`. The repo's producers (`encodeEvent` in `lib/mcp/events.ts`) always emit `\n`, so in practice this is a no-op — but keeping it preserves the correct shape for any future producer.

#### Move 2b — consumer 1: `useBriefingStream`

`lib/hooks/useBriefingStream.ts:288`. The canonical use site.

```ts
  // lib/hooks/useBriefingStream.ts:286-288 (excerpted)
  const handle = (evt: BriefingEvent) => {
    switch (evt.type) {
      case 'workspace':       ...                  // ← 9 cases
      case 'coverage_item':   ...
      case 'coverage':        ...
      case 'tool_call_start': ...
      case 'reasoning_step':  ...
      case 'tool_call_end':   ...
      case 'insight':         ...
      case 'done':            ...
      case 'error':           ...
    }
  };
  await readNdjson<BriefingEvent>(res.body, handle, { cancelOn: () => cancelledRef.current });
```

The 9-case dispatcher is the consumer's *only* responsibility. The 25-line stream loop is gone. The `cancelOn` plug-in honors React's effect cleanup: when the user navigates away or flips the mode toggle, `cancelledRef.current` flips true, the kernel polls it on its next read, cancels the reader, and exits.

#### Move 2c — consumer 2: `useInvestigation`

`lib/hooks/useInvestigation.ts:194`. Same pattern, different event vocabulary.

```ts
  // lib/hooks/useInvestigation.ts:194 (one line)
  await readNdjson<AgentEvent>(res.body, handle);
```

No `cancelOn` here — there's a deliberate reason. The hook documents (`:34-37`) that it does NOT cancel on cleanup, because React StrictMode (dev) mounts → cleans up → re-mounts, and cancelling on the first cleanup with the `startedRef` guard blocking the re-mount aborted the stream and left the trace empty. The hook chose a `startedRef` guard instead of `cancelOn`. **The kernel made that choice possible** — `cancelOn` is optional, so consumers opt in only when they actually want the cancellation semantics.

#### Move 2d — consumer 3: `useDemoCapture`

`lib/hooks/useDemoCapture.ts:84`. The dev-only capture flow that runs each investigation sequentially to land them in the cache.

```ts
  // lib/hooks/useDemoCapture.ts:82-88 (excerpted)
  let result = { ok: false, error: 'stream ended without done' };
  await readNdjson<{ type?: string; message?: string }>(res.body, (evt) => {
    if (evt.type === 'done') result = { ok: true };
    else if (evt.type === 'error') result = { ok: false, error: String(evt.message ?? 'error') };
  });
  return result;
```

This consumer doesn't even care about most event types — it only watches for `done` and `error`. **The kernel doesn't care that this consumer ignores most events.** The generic `<E>` means each consumer picks its own event type narrowness.

#### Move 2e — consumer 4: `StreamingResponse.tsx`

`components/chat/StreamingResponse.tsx:108`. The chat/Q&A streaming surface.

```ts
  // components/chat/StreamingResponse.tsx:108 (one line)
  await readNdjson<AgentEvent>(res.body, handleEvent);
```

Identical shape; different consumer.

#### Move 2f — bonus consumer: the test helper

`test/api/_helpers.ts:387`. The integration tests use the same kernel.

```ts
  // test/api/_helpers.ts:382-387 (annotated)
  /** Reuses the production readNdjson kernel so the tests can't drift from
   *  what runs in the browser. */
  export async function collectEvents<E>(response: Response): Promise<E[]> {
    const events: E[] = [];
    await readNdjson<E>(response.body, (e) => events.push(e));
    return events;
  }
```

**This is the load-bearing detail.** The test harness uses the production kernel. If the kernel had a bug, the integration tests would reproduce it. If a consumer behaves differently from the tests, the consumer is wrong. There's no risk of "test parser ≠ production parser" drift because there's only one parser.

### Move 2 variant — the load-bearing skeleton

The kernel: **(1) reader loop + (2) buffer split on `\n` + (3) per-line JSON.parse + (4) handler dispatch + (5) trailing-buffer flush + (6) `finally` release**.

What breaks when each part is missing:

  - **Drop the buffer's `lines.pop()`** — a chunk that ends mid-line throws on parse. The first long event would crash the stream.
  - **Drop the per-line try/catch around `JSON.parse`** — one malformed line takes down the whole stream. The kernel's "swallow + continue" policy is what lets the briefing finish even if the server bug emits one bad line.
  - **Drop `reader.releaseLock()` in `finally`** — second consumption attempt (on a re-render or retry) throws because the body is still locked.
  - **Drop the trailing-buffer flush** — works for the repo's producers (which always emit `\n`); breaks for any future producer that omits the terminal newline.
  - **Drop `cancelOn`** — React effects can't tell the stream to stop without aborting the underlying fetch; the loop runs to completion even after the user navigates away.

Optional hardening NOT in the kernel:

  - Backpressure / chunk-size limits.
  - Multi-line JSON support (the kernel assumes one event per line).
  - A schema validator on each event (consumers can add that on top in their handler).

Naming these as optional clarifies that they're not the load-bearing parts. The kernel is exactly the minimum to do NDJSON-over-fetch correctly.

### Move 3 — the principle

> **Duplication is a complexity multiplier; lifting is a complexity divider.**
>
> Three consumers with their own NDJSON loop is three places to fix the trailing-buffer bug, three places to add cancellation, three places to drift. One consumer with a shared kernel is one place. The win compounds: the kernel's tests cover all consumers; the kernel's hardening upgrades all consumers; the kernel's interface (a function with three parameters) is small enough that the consumers stay readable.
>
> The book's name for this is "pull complexity downward" — push the work into the lower-level module so the higher-level callers stay simple. The shape it takes here is one of the cleanest examples of the move in the repo.

---

## Primary diagram

```
  The kernel — five consumers, one body, one set of guarantees

  ┌─ consumers (production) ──┐  ┌─ consumer (test) ────────┐
  │                           │  │                          │
  │  useBriefingStream        │  │  collectEvents           │
  │    handle (9-case switch) │  │    handle (push to arr)  │
  │    cancelOn (mode flip)   │  │  test/api/_helpers.ts    │
  │  ───────────────────      │  │                          │
  │  useInvestigation         │  └──────────┬───────────────┘
  │    handle (AgentEvent)    │             │
  │    no cancelOn (StrictMode│             │
  │      reason documented)   │             │
  │  ───────────────────      │             │
  │  useDemoCapture           │             │
  │    handle (only done/err) │             │
  │  ───────────────────      │             │
  │  StreamingResponse        │             │
  │    handle (AgentEvent)    │             │
  └─────────┬─────────────────┘             │
            │                                │
            └────────────┬───────────────────┘
                         │  hands kernel:
                         │     body (ReadableStream<Uint8Array>)
                         │     onEvent (E) => void
                         │     opts? = { cancelOn?, onMalformed? }
                         ▼
  ┌─ lib/streaming/ndjson.ts (64 LOC) ───────────────────────────────┐
  │  readNdjson<E>(body, onEvent, opts?) — the kernel                │
  │                                                                  │
  │   reader = body.getReader()                                      │
  │   decoder = new TextDecoder()                                    │
  │   buf = ''                                                       │
  │   try:                                                           │
  │     loop:                                                        │
  │       if cancelOn() → reader.cancel() → return                   │
  │       read chunk; done? → break                                  │
  │       buf += decoder.decode(chunk, { stream: true })             │
  │       lines = buf.split('\\n');  buf = lines.pop()               │
  │       for line in lines:                                         │
  │         skip blanks                                              │
  │         try: onEvent(JSON.parse(line))                           │
  │         catch: onMalformed?(line, err)                           │
  │     flush trailing buf (no-op when producer terminates with \\n) │
  │   finally:                                                       │
  │     reader.releaseLock()                                         │
  └──────────────────────────────────────────────────────────────────┘

  one body, five callers, identical malformed-line + cancellation +
  trailing-buffer guarantees for every consumer
```

---

## Elaborate

**Where this primitive comes from.** Martin Fowler's "Extract Function" refactoring (1999) is the mechanical move; APOSD names the design intent ("pull complexity downward"). The combination is what justifies extracting in the first place — Extract Function for its own sake is just code shuffling; pulling complexity down is the design reason.

**What changed in this codebase.** Before the lift (commit `0f06eff`), three consumers (`useBriefingStream`, `useInvestigation`, `StreamingResponse`) each had their own inline stream loop — ~25 LOC × 3 = ~75 LOC of duplicated stream-reading boilerplate. After the lift, the kernel is 64 LOC + each consumer is one `await readNdjson(...)` call. Net code reduction ≈ 75 → 64 LOC, but the bigger win is the *quality floor* — every consumer now gets the same malformed-line policy, the same trailing-buffer flush, the same `finally` lock release.

**What's adjacent in this codebase.**

  - `01-deep-module-data-source.md` — input-side dual: one interface, many callers (at class scale rather than function scale).
  - `02-information-hiding-aptkit-bridge.md` — the bridge layer hides its callers' types from each other (different rule, same hiding instinct).
  - `audit.md` Lens 5 (pull-complexity-downward) for the full lens treatment.

**What to read next.** `.aipe/read-aposd/part-2/07-pull-complexity-down.md`.

---

## Interview defense

**Q1: Walk me through a refactor where you pulled complexity downward.**

The `readNdjson` kernel at `lib/streaming/ndjson.ts`. Three React hooks plus a chat component were all doing the same `fetch → body.getReader() → TextDecoder → buffer → split('\n') → JSON.parse → dispatch` loop inline — about 25 lines repeated three times with subtle differences in how each handled malformed lines and cleanup. I lifted the loop into one 64-LOC kernel generic over `<E>`. Now each consumer hands it a body and a handler; the kernel owns the buffering, decoding, line splitting, malformed-line policy, cancellation polling, and `finally` lock release. The test integration helper uses the SAME kernel — there's no risk of test parser ≠ production parser drift.

```
   before                            after
   ──────                            ─────
   3× inline 25-LOC loops            1× 64-LOC kernel
   3× slightly different             5× consumers (4 prod + 1 test)
     malformed-line behavior          each is one await readNdjson(...)
   3× ways to leak the reader        identical guarantees everywhere
     lock on cancel
```

Anchor: `lib/streaming/ndjson.ts`.

**Q2: What's the load-bearing part of the kernel? The one people forget when they re-implement it?**

`buf = lines.pop() ?? ''`. The streaming `fetch` doesn't promise chunks end at line boundaries — most don't. Whatever follows the last `\n` in a chunk is an incomplete event and has to be carried into the next iteration. People miss this and get "JSON parse error on `{"type":"reaso`" because they parsed a truncated line. The kernel `split`s on `\n`, processes everything except the last element, and saves the tail for the next chunk. Without that line, the first long event crashes the stream.

The trailing-buffer flush after the loop is the other detail — it handles the rare producer that omits the final `\n`. The repo's producers always emit it, so the flush is a no-op in practice, but it preserves the correct shape for any future producer.

```
  one chunk arrives:    "...evt1\nevt2\nevt3-par"
                                              ^^^^^ incomplete
  split('\\n'):         ["...evt1", "evt2", "evt3-par"]
  pop():                buf = "evt3-par"      ← saved for next chunk
  process the rest:     ["...evt1", "evt2"]   ← parse + dispatch
```

Anchor: `lib/streaming/ndjson.ts:40-41`.

**Q3: Why is `cancelOn` a polled callback, not an `AbortSignal`?**

Because the kernel polls *between* reads — it's not preemptive. The consumer (typically a React effect) just sets a ref to true on cleanup; the kernel checks the ref on its next loop iteration, calls `reader.cancel()`, and exits. An `AbortSignal` on the fetch would be preemptive, but the repo's consumers don't always need that — `useInvestigation` deliberately does NOT cancel on cleanup because React StrictMode's mount-unmount-remount cycle would abort the stream and leave the trace empty. So the kernel offers cancellation as opt-in (`cancelOn?` is optional) and lets the consumer choose. The result is the kernel works with both "yes, cancel me on cleanup" and "no, let me run to completion" without changing its surface.

Anchor: `lib/streaming/ndjson.ts:33-36` and `lib/hooks/useInvestigation.ts:34-37` (the StrictMode rationale).

**Q4: Are there cases where pulling complexity down would be the wrong move?**

Yes — when the "duplication" is incidental rather than essential. If three places happen to have similar-looking code but the structure exists for unrelated reasons, lifting it creates a false abstraction that calcifies a coincidence. The lifted module then becomes harder to change because it serves multiple unrelated callers who each have different evolution pressures. The test for `readNdjson`: all four consumers are reading NDJSON-over-fetch — the duplication is essential, the lift is genuine. If two consumers had been NDJSON-over-fetch and one had been line-delimited CSV, lifting all three would have been the wrong move.

The check is "would I want all consumers to inherit the same hardening?" For NDJSON parsing — yes, every consumer wants the same malformed-line policy. So the lift is justified.

Anchor: `lib/streaming/ndjson.ts` (the kernel) vs the consumers that explicitly do NOT use it because they're not reading NDJSON.

---

## See also

  → `01-deep-module-data-source.md` — input-side dual: one interface, many callers at class scale.
  → `02-information-hiding-aptkit-bridge.md` — hiding lesson at the agent layer.
  → `04-shallow-module-page-component-resolved.md` — page-decomposition story where lifting `readNdjson` was one of the preconditions.
  → `audit.md` Lens 5 (pull-complexity-downward).
  → `.aipe/read-aposd/part-2/07-pull-complexity-down.md`.
