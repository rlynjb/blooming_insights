// lib/streaming/ndjson.ts
//
// One kernel for the `fetch → reader → TextDecoder → buffer → split('\n') →
// JSON.parse → handle(event)` loop that the live briefing, the capture path,
// the investigation hook, and the chat surface all run. The shape here matches
// the main briefing effect (the canonical implementation): flush the trailing
// buffer at end-of-stream, silently skip malformed lines, and poll `cancelOn`
// between reads so an unmounted consumer can break out cleanly.
//
// Producers (briefing + agent routes via `encodeEvent`) always terminate each
// event with '\n', so in practice the trailing-buffer flush is a no-op — but
// keeping it preserves the correct shape for any future producer that omits
// the terminal newline.

/** Read an NDJSON byte stream, parse one event per line, and dispatch each to
 *  `onEvent`. Returns when the stream ends or `cancelOn` returns true. */
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
  opts?: {
    /** Polled between reads; if it returns true, the reader is cancelled and
     *  the loop exits without processing the next chunk. */
    cancelOn?: () => boolean;
    /** Called once per malformed line (JSON.parse threw). Default: silent. */
    onMalformed?: (line: string, err: unknown) => void;
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
    // flush trailing buffer — a no-op when the producer always terminates with '\n'
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
