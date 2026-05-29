import { describe, it, expect } from 'vitest';
import { deriveInsightFields, diagnosisConfidence, hypothesesTested, impactRange, impactAssumption } from '../../lib/insights/derive';
import type { Anomaly, Diagnosis } from '../../lib/mcp/types';

const revenueAnomaly: Anomaly = {
  metric: 'purchase_revenue',
  scope: ['usa'],
  change: { value: 58.3, direction: 'down', baseline: '90d' },
  severity: 'critical',
  evidence: [{ tool: 'execute_analytics_eql', result: { current: 42000, prior: 138000 } }],
};

describe('deriveInsightFields', () => {
  it('derives a revenue impact from current/prior evidence on a down revenue metric', () => {
    const f = deriveInsightFields(revenueAnomaly);
    expect(f.revenueImpact).toEqual({ lostUsd: -96000, expectedUsd: 138000, currency: 'USD' });
  });

  it('does not derive revenue impact for non-revenue metrics', () => {
    const f = deriveInsightFields({ ...revenueAnomaly, metric: 'session_count' });
    expect(f.revenueImpact).toBeUndefined();
  });

  it('does not derive revenue impact when the change is up', () => {
    const f = deriveInsightFields({ ...revenueAnomaly, change: { value: 10, direction: 'up', baseline: '90d' } });
    expect(f.revenueImpact).toBeUndefined();
  });

  it('returns no fields when evidence has no current/prior', () => {
    expect(deriveInsightFields({ ...revenueAnomaly, evidence: [{ tool: 't', result: {} }] })).toEqual({});
  });
});

describe('diagnosisConfidence', () => {
  const base: Diagnosis = { conclusion: 'c', evidence: [], hypothesesConsidered: [] };
  it('prefers the agent-set confidence', () => {
    expect(diagnosisConfidence({ ...base, confidence: 'low' })).toBe('low');
  });
  it('is low with no hypotheses', () => {
    expect(diagnosisConfidence(base)).toBe('low');
  });
  it('is high when all tested and one supported', () => {
    expect(
      diagnosisConfidence({
        ...base,
        hypothesesConsidered: [
          { hypothesis: 'a', supported: true, reasoning: 'r1' },
          { hypothesis: 'b', supported: false, reasoning: 'r2' },
        ],
      }),
    ).toBe('high');
  });
  it('is medium when supported but some untested', () => {
    expect(
      diagnosisConfidence({
        ...base,
        hypothesesConsidered: [
          { hypothesis: 'a', supported: true, reasoning: 'r1' },
          { hypothesis: 'b', supported: false, reasoning: '' },
        ],
      }),
    ).toBe('medium');
  });
  it('is low when nothing supported', () => {
    expect(
      diagnosisConfidence({ ...base, hypothesesConsidered: [{ hypothesis: 'a', supported: false, reasoning: 'r' }] }),
    ).toBe('low');
  });
});

describe('hypothesesTested / impact helpers', () => {
  it('counts tested vs total', () => {
    const d: Diagnosis = {
      conclusion: 'c',
      evidence: [],
      hypothesesConsidered: [
        { hypothesis: 'a', supported: true, reasoning: 'r' },
        { hypothesis: 'b', supported: false, reasoning: '' },
      ],
    };
    expect(hypothesesTested(d)).toEqual({ tested: 1, total: 2 });
  });
  it('normalizes both impact shapes', () => {
    expect(impactRange('recovers ~20%')).toBe('recovers ~20%');
    expect(impactRange({ range: '+$14k–$23k', assumption: 'a' })).toBe('+$14k–$23k');
    expect(impactAssumption('recovers ~20%')).toBeNull();
    expect(impactAssumption({ range: 'x', assumption: 'assumes y' })).toBe('assumes y');
  });
});
