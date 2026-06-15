# Refactor — extract `readNdjson` from 4 duplicated sites

> Source finding: `.aipe/audits/cleanup-2026-06-14T19-50-14.md` fix-now #3.
> Originating: cleanup-2026-06-14.md morning #24 (promoted from fix-later → fix-now after morning's seven items resolved).

---

## What to refactor

The same `fetch → res.body.getReader() → TextDecoder → buffer → split('\n') → JSON.parse(line) → handle(event)` loop lives in 4 places, with documented drift on three real axes (trailing-buffer flush, malformed-line policy, reader.cancel-on-unmount). Lift the kernel into one function in a new `lib/streaming/` module.

**The four sites:**
- `app/page.tsx:181-203` — capture path (`captureAll()` button handler; silently drops trailing buffer)
- `app/page.tsx:323-464` — main briefing effect (flushes trailing buffer; cancels reader on unmount)
- `lib/hooks/useInvestigation.ts:184-208` — investigation NDJSON consumer (flushes trailing buffer; doesn't cancel)
- `components/chat/StreamingResponse.tsx:107-126` — chat NDJSON consumer (silently drops trailing buffer)

The drift across these four is what the extraction unifies. The `app/page.tsx` main effect at `:323-464` already implements the *correct* shape (flush + cancel + silent-skip); the other three drifted from it.

---

## Why

Three reasons, in order of leverage:

1. **It is the blocker for the page.tsx shallow-module refactor (fix-later #4 / morning #8).** That refactor is 817 LOC across 8 concerns, and one of those concerns is the NDJSON parser — which can't be cleanly extracted into `useBriefingStream(mode)` if the parser shape itself is unstable. Stabilize the parser first, then the hook lift is mechanical.

2. **Four copies of one loop is the canonical "four engineers will fix bugs in different copies" setup.** The drift on three axes is already a record of it happening: each engineer who touched one site made a local choice. The shape is right; let one file own it.

3. **The 183-test suite has zero NDJSON-stream tests.** Extracting the kernel into one function lets one unit test cover the contract (buffer-tail flush, malformed-line skip, cancel-on-unmount). Without extraction, the contract test would have to be 4 copies as well — which is why it doesn't exist today.

---

## Target structure

**New file: `lib/streaming/ndjson.ts`.**

Export one function:

```
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
  opts?: {
    cancelOn?: () => boolean;       // poll between reads; if true, reader.cancel()
    onMalformed?: (line: string, err: unknown) => void;  // default: silent
  },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (opts?.cancelOn?.()) {
        await reader.cancel();
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as E);
        } catch (err) {
          opts?.onMalformed?.(line, err);
        }
      }
    }
    // flush trailing buffer
    const tail = buf.trim();
    if (tail) {
      try {
        onEvent(JSON.parse(tail) as E);
      } catch (err) {
        opts?.onMalformed?.(tail, err);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

Defaults match `app/page.tsx`'s main effect (the correct shape): flush trailing buffer, silently skip malformed lines, cancel when `cancelOn()` returns true.

**New test: `test/streaming/ndjson.test.ts`.** Pins the four behaviors that the four copies disagree on today:

- Multi-line chunk: emits one event per line.
- Split across two reads: lines reassemble correctly.
- Trailing buffer at end: gets flushed as one final event.
- Malformed line in middle: skipped silently; subsequent lines still emit.
- `cancelOn` returns true: `reader.cancel()` called; loop exits before next read.

**Replace 4 call sites:**

- `app/page.tsx:181-203` (capture path) → `await readNdjson(res.body, (evt) => { /* type-route */ });`
- `app/page.tsx:323-464` (main briefing effect) → `await readNdjson(res.body, handle, { cancelOn: () => !mounted });`
- `lib/hooks/useInvestigation.ts:184-208` → `await readNdjson(res.body, handle);`
- `components/chat/StreamingResponse.tsx:107-126` → `await readNdjson(res.body, handleEvent);`

Each call site collapses from ~25 LOC to ~5 LOC.

**End state:**
- One `readNdjson` function owns the kernel.
- One unit test pins the contract.
- Four call sites become consumer-only — no reader, no decoder, no buffer.
- `page.tsx` shallow-module refactor is unblocked on its parser-extraction precondition.

---

## Must not change

[BLANK — fill before execution]

---

## Must not introduce

[BLANK — fill before execution]
