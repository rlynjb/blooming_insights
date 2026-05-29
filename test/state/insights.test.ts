import { describe, it, expect, beforeEach } from 'vitest';
import { anomalyToInsight, putInsights, getInsight, getAnomaly, listInsights, putInvestigation, getInvestigation, _clear } from '../../lib/state/insights';
import type { Anomaly } from '../../lib/mcp/types';

const anomaly: Anomaly = {
  metric: 'conversion_rate', scope: ['mobile', 'checkout'],
  change: { value: -18, direction: 'down', baseline: '7d' },
  severity: 'warning', evidence: [],
};

describe('insight state', () => {
  beforeEach(() => _clear());
  it('maps an anomaly to a lowercase insight with a stable-shaped id', () => {
    const i = anomalyToInsight(anomaly);
    expect(i.id).toBeTruthy();
    expect(i.severity).toBe('warning');
    expect(i.metric).toBe('conversion_rate');
    expect(i.source).toBe('monitoring');
    expect(i.scope).toEqual(['mobile', 'checkout']);
    expect(i.headline).toBe(i.headline.toLowerCase());
    expect(i.change).toEqual(anomaly.change);
    expect(typeof i.timestamp).toBe('string');
  });
  it('carries the agent business-impact + outlook sentences onto the insight', () => {
    const withDetail: Anomaly = {
      ...anomaly,
      impact: 'Conversion is the funnel hinge — an 18% drop here loses orders even at flat traffic.',
      outlook: 'If this holds, expect order volume to keep sliding next period as the funnel leaks.',
    };
    const i = anomalyToInsight(withDetail);
    expect(i.impact).toBe(withDetail.impact);
    expect(i.outlook).toBe(withDetail.outlook);
    // absent on anomalies that don't provide them (older snapshots)
    expect(anomalyToInsight(anomaly).impact).toBeUndefined();
    expect(anomalyToInsight(anomaly).outlook).toBeUndefined();
  });
  it('stores/retrieves insights and their source anomalies by id', () => {
    const i = anomalyToInsight(anomaly);
    putInsights([i], [anomaly]);
    expect(getInsight(i.id)?.id).toBe(i.id);
    expect(getAnomaly(i.id)).toEqual(anomaly);
    expect(listInsights()).toHaveLength(1);
  });
  it('returns null for unknown ids', () => {
    expect(getInsight('nope')).toBeNull();
    expect(getAnomaly('nope')).toBeNull();
    expect(getInvestigation('nope')).toBeNull();
  });
  it('stores/retrieves an investigation by insightId', () => {
    const inv = { insightId: 'i1', reasoning: [], diagnosis: { conclusion: 'c', evidence: [], hypothesesConsidered: [] }, recommendations: [] };
    putInvestigation(inv);
    expect(getInvestigation('i1')?.insightId).toBe('i1');
  });
});
