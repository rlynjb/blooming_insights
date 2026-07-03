// test/state/in-flight-briefings.test.ts
//
// The in-flight briefing gate — the ONE piece of coordination that closes
// the concurrent-same-session `putInsights` race documented in the drill
// at .aipe/drills/l1-correctness-induce-concurrent-briefing-race.md.
//
// These tests cover the primitive directly (route-level integration is
// verified by code review + the tombstone-in-context comment in the module;
// spinning the streaming route through a mocked Anthropic + mocked MCP is
// out of scope for this suite and would duplicate coverage the primitive
// already gives).

import { afterEach, describe, it, expect } from 'vitest';
import {
  tryAcquireBriefing,
  _clearAllBriefings,
  _inFlightCount,
} from '../../lib/state/in-flight-briefings';

describe('in-flight briefing gate', () => {
  afterEach(() => _clearAllBriefings());

  it('first acquisition succeeds and returns a controller + release fn', () => {
    const result = tryAcquireBriefing('sid-1');
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(result.controller).toBeInstanceOf(AbortController);
      expect(typeof result.release).toBe('function');
    }
  });

  it('concurrent acquisition on the same sessionId fails', () => {
    const first = tryAcquireBriefing('sid-1');
    const second = tryAcquireBriefing('sid-1');
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.existing).toBeInstanceOf(AbortController);
    }
  });

  it('release lets the next acquisition on the same sessionId succeed', () => {
    const first = tryAcquireBriefing('sid-1');
    if (!first.acquired) throw new Error('first should acquire');
    first.release();
    const second = tryAcquireBriefing('sid-1');
    expect(second.acquired).toBe(true);
  });

  it('different sessionIds do not block each other', () => {
    const a = tryAcquireBriefing('sid-A');
    const b = tryAcquireBriefing('sid-B');
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(_inFlightCount()).toBe(2);
  });

  it('closes the race documented in the drill', () => {
    // Simulates the concurrent-same-session race: two overlapping /api/briefing
    // requests → in the pre-fix world, both traverse ~30-90s of async MCP work
    // and both call putInsights, second clobbering first. With the gate, the
    // second acquisition fails; the route returns 409 and the second request
    // never reaches its putInsights call.
    const first = tryAcquireBriefing('sid-race');
    const second = tryAcquireBriefing('sid-race');
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
  });

  it('release only removes OUR controller (safe against stale releases)', () => {
    const first = tryAcquireBriefing('sid-1');
    if (!first.acquired) throw new Error('first should acquire');
    first.release(); // gate is now free
    const second = tryAcquireBriefing('sid-1');
    if (!second.acquired) throw new Error('second should acquire');
    first.release(); // stale — should be a no-op, must NOT free second's slot
    expect(_inFlightCount()).toBe(1); // second's gate still held
    if (!second.acquired) throw new Error('narrowing');
    second.release();
    expect(_inFlightCount()).toBe(0);
  });

  it('acquisitions across many sessions accumulate cleanly', () => {
    const releases: Array<() => void> = [];
    for (let i = 0; i < 100; i++) {
      const r = tryAcquireBriefing(`sid-${i}`);
      expect(r.acquired).toBe(true);
      if (r.acquired) releases.push(r.release);
    }
    expect(_inFlightCount()).toBe(100);
    for (const rel of releases) rel();
    expect(_inFlightCount()).toBe(0);
  });

  it('the existing controller returned to a rejected caller is the holder\'s controller', () => {
    // This lets the route (or a future feature) reason about the in-flight
    // request — e.g., could abort the prior one and let the new one start.
    // Today we don't do that; we 409 the new caller. But the surface is here.
    const first = tryAcquireBriefing('sid-1');
    if (!first.acquired) throw new Error('first should acquire');
    const second = tryAcquireBriefing('sid-1');
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.existing).toBe(first.controller);
    }
  });
});
