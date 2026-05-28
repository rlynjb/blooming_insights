// test/mcp/events.test.ts
import { describe, it, expect } from 'vitest';
import { encodeEvent, decodeEvent } from '../../lib/mcp/events';
import type { AgentEvent } from '../../lib/mcp/events';

describe('AgentEvent codec', () => {
  // ---------------------------------------------------------------------------
  // Round-trip tests
  // ---------------------------------------------------------------------------

  it('round-trips { type: "done" }', () => {
    const event: AgentEvent = { type: 'done' };
    expect(decodeEvent(encodeEvent(event).trimEnd())).toEqual(event);
  });

  it('round-trips a tool_call_start event', () => {
    const event: AgentEvent = {
      type: 'tool_call_start',
      toolName: 'get_project_overview',
      agent: 'monitoring',
    };
    expect(decodeEvent(encodeEvent(event).trimEnd())).toEqual(event);
  });

  it('round-trips a reasoning_step event', () => {
    const event: AgentEvent = {
      type: 'reasoning_step',
      step: {
        id: 'step-1',
        agent: 'diagnostic',
        kind: 'thought',
        content: 'I am thinking...',
      },
    };
    expect(decodeEvent(encodeEvent(event).trimEnd())).toEqual(event);
  });

  it('round-trips an error event', () => {
    const event: AgentEvent = { type: 'error', message: 'something went wrong' };
    expect(decodeEvent(encodeEvent(event).trimEnd())).toEqual(event);
  });

  // ---------------------------------------------------------------------------
  // Format constraints
  // ---------------------------------------------------------------------------

  it('encodeEvent output ends with "\\n"', () => {
    const line = encodeEvent({ type: 'done' });
    expect(line.endsWith('\n')).toBe(true);
  });

  it('encodeEvent output contains no interior newline', () => {
    const event: AgentEvent = {
      type: 'reasoning_step',
      step: {
        id: 'step-2',
        agent: 'coordinator',
        kind: 'conclusion',
        content: 'line one\nline two',
      },
    };
    const encoded = encodeEvent(event);
    // Strip the trailing newline — remaining content must have no newlines
    const interior = encoded.slice(0, -1);
    expect(interior.includes('\n')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Batch decode
  // ---------------------------------------------------------------------------

  it('decodes a batch of NDJSON lines correctly', () => {
    const e1: AgentEvent = { type: 'tool_call_start', toolName: 'foo', agent: 'coordinator' };
    const e2: AgentEvent = { type: 'done' };
    const batch = encodeEvent(e1) + encodeEvent(e2);
    const decoded = batch.split('\n').filter(Boolean).map(decodeEvent);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toEqual(e1);
    expect(decoded[1]).toEqual(e2);
  });
});
