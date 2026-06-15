import { describe, it, expect, vi } from 'vitest';
import { readNdjson } from '../../lib/streaming/ndjson';

/** Build a ReadableStream that emits the given byte chunks in order. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

type Evt = { type: string; n?: number };

describe('readNdjson', () => {
  it('emits one event per line for a multi-line chunk', async () => {
    const events: Evt[] = [];
    const body = streamOf('{"type":"a","n":1}\n{"type":"b","n":2}\n{"type":"c","n":3}\n');
    await readNdjson<Evt>(body, (e) => events.push(e));
    expect(events).toEqual([
      { type: 'a', n: 1 },
      { type: 'b', n: 2 },
      { type: 'c', n: 3 },
    ]);
  });

  it('reassembles a line split across two reads', async () => {
    const events: Evt[] = [];
    // first read carries half of one event; second read carries the rest + a
    // full second event. The kernel must stitch the halves together.
    const body = streamOf('{"type":"a","n', '":1}\n{"type":"b","n":2}\n');
    await readNdjson<Evt>(body, (e) => events.push(e));
    expect(events).toEqual([
      { type: 'a', n: 1 },
      { type: 'b', n: 2 },
    ]);
  });

  it('flushes a trailing buffer (no terminal newline) as a final event', async () => {
    const events: Evt[] = [];
    // last line lacks the terminating '\n' — must still be emitted at end.
    const body = streamOf('{"type":"a"}\n{"type":"tail"}');
    await readNdjson<Evt>(body, (e) => events.push(e));
    expect(events).toEqual([{ type: 'a' }, { type: 'tail' }]);
  });

  it('silently skips a malformed line in the middle; subsequent lines still emit', async () => {
    const events: Evt[] = [];
    const malformed: string[] = [];
    const body = streamOf('{"type":"a"}\nnot json{\n{"type":"c"}\n');
    await readNdjson<Evt>(
      body,
      (e) => events.push(e),
      { onMalformed: (line) => malformed.push(line) },
    );
    expect(events).toEqual([{ type: 'a' }, { type: 'c' }]);
    expect(malformed).toEqual(['not json{']);
  });

  it('cancels the reader and exits when cancelOn returns true', async () => {
    const events: Evt[] = [];
    const cancelSpy = vi.fn();
    const enc = new TextEncoder();

    // A stream whose first read succeeds, then `cancelOn` flips to true so the
    // loop must call reader.cancel() before attempting a second read.
    let firstRead = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstRead) {
          firstRead = false;
          controller.enqueue(enc.encode('{"type":"a"}\n'));
        } else {
          // If we ever get here the loop kept reading after cancelOn → true.
          controller.enqueue(enc.encode('{"type":"should-not-emit"}\n'));
        }
      },
      cancel(reason) {
        cancelSpy(reason);
      },
    });

    let cancel = false;
    await readNdjson<Evt>(
      body,
      (e) => {
        events.push(e);
        cancel = true; // request cancellation after the first event
      },
      { cancelOn: () => cancel },
    );

    expect(events).toEqual([{ type: 'a' }]);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});
