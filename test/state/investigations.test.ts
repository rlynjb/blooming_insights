import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getCachedInvestigation,
  saveInvestigation,
  _clearInvestigationCache,
} from '../../lib/state/investigations';
import type { AgentEvent } from '../../lib/mcp/events';

// Derive a real id from the committed demo seed rather than hard-coding one —
// the ids change every time the demo snapshot is re-captured.
const DEMO_SEED = JSON.parse(
  readFileSync(join(process.cwd(), 'lib/state/demo-investigations.json'), 'utf8'),
) as Record<string, AgentEvent[]>;
const DEMO_ID = Object.keys(DEMO_SEED)[0];

const sample: AgentEvent[] = [
  { type: 'reasoning_step', step: { id: 's', agent: 'diagnostic', kind: 'thought', content: 'hi' } },
  { type: 'done' },
];

describe('investigation cache', () => {
  beforeEach(() => _clearInvestigationCache());

  it('round-trips saved events for an id', () => {
    saveInvestigation('i1', sample);
    expect(getCachedInvestigation('i1')).toEqual(sample);
  });

  it('returns null for an unknown id', () => {
    expect(getCachedInvestigation('does-not-exist')).toBeNull();
  });

  it('falls back to the committed demo seed', () => {
    const events = getCachedInvestigation(DEMO_ID);
    expect(Array.isArray(events)).toBe(true);
    expect(events!.length).toBeGreaterThan(0);
    expect(events![events!.length - 1]).toEqual({ type: 'done' });
  });

  it('_clearInvestigationCache clears in-memory entries', () => {
    saveInvestigation('i2', sample);
    expect(getCachedInvestigation('i2')).toEqual(sample);
    _clearInvestigationCache();
    expect(getCachedInvestigation('i2')).toBeNull();
  });
});
