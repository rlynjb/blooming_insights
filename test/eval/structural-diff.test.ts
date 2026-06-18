import { describe, expect, it } from 'vitest';

import { structuralDiff } from '../../eval/scripts/lib/structural-diff';

describe('regression structural diff', () => {
  it('uses AptKit path resolution while preserving the legacy result shape', () => {
    const result = structuralDiff(
      {
        diagnosis: {
          evidence: ['spike'],
        },
      },
      {
        diagnosis: {
          evidence: ['baseline'],
        },
      },
      {
        requiredFields: ['diagnosis.evidence.0'],
        strict: true,
      },
    );

    expect(result).toEqual({
      pass: true,
      missing_required_fields: [],
      type_mismatches: [],
      unexpected_fields: [],
      notes: [],
    });
  });

  it('reports missing fields, type mismatches, and strict top-level surprises', () => {
    const result = structuralDiff(
      {
        diagnosis: {
          evidence: 'not an array',
        },
        extra: true,
      },
      {
        diagnosis: {
          evidence: ['baseline'],
          confidence: 'high',
        },
      },
      {
        requiredFields: ['diagnosis.evidence', 'diagnosis.confidence'],
        strict: true,
      },
    );

    expect(result.pass).toBe(false);
    expect(result.missing_required_fields).toEqual(['diagnosis.confidence']);
    expect(result.type_mismatches).toEqual([
      { path: 'diagnosis.evidence', expected: 'array', got: 'string' },
    ]);
    expect(result.unexpected_fields).toEqual(['extra']);
  });
});
