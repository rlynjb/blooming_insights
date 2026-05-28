import { describe, it, expect } from 'vitest';
import { parseAgentJson, isAnomalyArray, isDiagnosis } from '../../lib/mcp/validate';

describe('parseAgentJson', () => {
  it('extracts a json array from a fenced ```json block', () => {
    expect(parseAgentJson('here:\n```json\n[{"metric":"x"}]\n```')).toEqual([{ metric: 'x' }]);
  });
  it('extracts from an unlabelled ``` block', () => {
    expect(parseAgentJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('parses bare json', () => {
    expect(parseAgentJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('finds a json array embedded in prose', () => {
    expect(parseAgentJson('Sure! [1,2,3] done')).toEqual([1, 2, 3]);
  });
  it('throws on text with no json', () => {
    expect(() => parseAgentJson('no json here')).toThrow();
  });
});

describe('isAnomalyArray', () => {
  const good = [{ metric: 'conversion_rate', scope: ['mobile'], change: { value: -18, direction: 'down', baseline: '7d' }, severity: 'warning', evidence: [] }];
  it('accepts a well-formed anomaly array', () => { expect(isAnomalyArray(good)).toBe(true); });
  it('accepts an empty array', () => { expect(isAnomalyArray([])).toBe(true); });
  it('rejects a non-array', () => { expect(isAnomalyArray({})).toBe(false); });
  it('rejects a missing-field object', () => { expect(isAnomalyArray([{ metric: 'x' }])).toBe(false); });
  it('rejects a bad severity', () => { expect(isAnomalyArray([{ ...good[0], severity: 'huge' }])).toBe(false); });
  it('rejects a bad direction', () => { expect(isAnomalyArray([{ ...good[0], change: { value: 1, direction: 'sideways', baseline: '7d' } }])).toBe(false); });
});

describe('isDiagnosis', () => {
  const wellFormed = {
    conclusion: 'Mobile checkout conversion dropped due to a new payment flow.',
    evidence: ['purchase count on mobile dropped 23%', 'desktop unaffected'],
    hypothesesConsidered: [
      { hypothesis: 'Payment UI regression', supported: true, reasoning: 'Correlates with deploy date.' },
      { hypothesis: 'Seasonal dip', supported: false, reasoning: 'Desktop was stable.' },
    ],
    affectedCustomers: { count: 1200, segmentDescription: 'Mobile shoppers' },
  };

  it('accepts a well-formed diagnosis', () => {
    expect(isDiagnosis(wellFormed)).toBe(true);
  });

  it('accepts a diagnosis with empty evidence and hypotheses arrays', () => {
    expect(isDiagnosis({ conclusion: 'No data.', evidence: [], hypothesesConsidered: [] })).toBe(true);
  });

  it('rejects a non-object (null)', () => {
    expect(isDiagnosis(null)).toBe(false);
  });

  it('rejects a non-object (string)', () => {
    expect(isDiagnosis('some string')).toBe(false);
  });

  it('rejects an object missing conclusion', () => {
    const { conclusion: _c, ...rest } = wellFormed;
    expect(isDiagnosis(rest)).toBe(false);
  });

  it('rejects an object where evidence is not an array', () => {
    expect(isDiagnosis({ conclusion: 'ok', evidence: 'not-an-array', hypothesesConsidered: [] })).toBe(false);
  });
});
