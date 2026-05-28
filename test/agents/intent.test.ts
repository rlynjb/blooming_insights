// test/agents/intent.test.ts
import { describe, it, expect } from 'vitest';
import { parseIntent } from '../../lib/agents/intent';

describe('parseIntent', () => {
  it('returns "monitoring" for the word "monitoring"', () => {
    expect(parseIntent('monitoring')).toBe('monitoring');
  });

  it('returns "diagnostic" for "  DIAGNOSTIC " (case-insensitive, trimmed)', () => {
    expect(parseIntent('  DIAGNOSTIC ')).toBe('diagnostic');
  });

  it('returns "recommendation" for the word "recommendation"', () => {
    expect(parseIntent('recommendation')).toBe('recommendation');
  });

  it('returns "recommendation" for a sentence containing "recommendation" (substring match)', () => {
    expect(parseIntent('The intent is: recommendation.')).toBe('recommendation');
  });

  it('returns "diagnostic" for unrecognised input (default)', () => {
    expect(parseIntent('???')).toBe('diagnostic');
  });

  it('returns "diagnostic" for an empty string (default)', () => {
    expect(parseIntent('')).toBe('diagnostic');
  });

  it('returns "monitoring" when both "monitoring" and "diagnostic" appear (monitoring checked first)', () => {
    expect(parseIntent('monitoring and diagnostic both appear here')).toBe('monitoring');
  });
});
