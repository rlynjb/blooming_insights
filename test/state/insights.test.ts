import { describe, it, expect, beforeEach } from 'vitest';
import { anomalyToInsight, putInsights, getInsight, getAnomaly, listInsights, putInvestigation, getInvestigation, _clear } from '../../lib/state/insights';
import type { Anomaly } from '../../lib/mcp/types';

const SID = 'test-session';

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
  it('carries the agent business-impact sentence onto the insight', () => {
    const withImpact: Anomaly = { ...anomaly, impact: 'Conversion is the funnel hinge — an 18% drop here loses orders even at flat traffic.' };
    expect(anomalyToInsight(withImpact).impact).toBe(withImpact.impact);
    // absent on anomalies that don't provide it (older snapshots / no impact)
    expect(anomalyToInsight(anomaly).impact).toBeUndefined();
  });
  it('stores/retrieves insights and their source anomalies by id', () => {
    const i = anomalyToInsight(anomaly);
    putInsights(SID, [i], [anomaly]);
    expect(getInsight(SID, i.id)?.id).toBe(i.id);
    expect(getAnomaly(SID, i.id)).toEqual(anomaly);
    expect(listInsights(SID)).toHaveLength(1);
  });
  it('returns null for unknown ids', () => {
    expect(getInsight(SID, 'nope')).toBeNull();
    expect(getAnomaly(SID, 'nope')).toBeNull();
    expect(getInvestigation(SID, 'nope')).toBeNull();
  });
  it('stores/retrieves an investigation by insightId', () => {
    const inv = { insightId: 'i1', reasoning: [], diagnosis: { conclusion: 'c', evidence: [], hypothesesConsidered: [] }, recommendations: [] };
    putInvestigation(SID, inv);
    expect(getInvestigation(SID, 'i1')?.insightId).toBe('i1');
  });

  // Cross-session isolation: the bug this refactor fixes. Two sessions writing
  // concurrently must not overwrite or read each other's feed state — putInsights
  // clears only the caller's sub-map, never the outer map or another session's.
  it('isolates insights and anomalies across sessions', () => {
    const a: Anomaly = { ...anomaly };
    const b: Anomaly = { ...anomaly, metric: 'session_start', scope: ['global'] };
    const iA = anomalyToInsight(a);
    const iB = anomalyToInsight(b);
    putInsights('session-a', [iA], [a]);
    putInsights('session-b', [iB], [b]);
    // each session sees only its own insight
    expect(getInsight('session-a', iA.id)?.id).toBe(iA.id);
    expect(getInsight('session-a', iB.id)).toBeNull();
    expect(getInsight('session-b', iB.id)?.id).toBe(iB.id);
    expect(getInsight('session-b', iA.id)).toBeNull();
    expect(listInsights('session-a')).toHaveLength(1);
    expect(listInsights('session-b')).toHaveLength(1);
    // anomalies are isolated too
    expect(getAnomaly('session-a', iA.id)).toEqual(a);
    expect(getAnomaly('session-b', iA.id)).toBeNull();
  });

  it('putInsights for one session does not wipe another session', () => {
    const iA = anomalyToInsight(anomaly);
    putInsights('session-a', [iA], [anomaly]);
    // a second session's briefing arrives — must not clear session-a
    const iB = anomalyToInsight({ ...anomaly, metric: 'purchase_revenue' });
    putInsights('session-b', [iB]);
    expect(getInsight('session-a', iA.id)?.id).toBe(iA.id);
    expect(listInsights('session-a')).toHaveLength(1);
  });
});
