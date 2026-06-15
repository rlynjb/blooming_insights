import { describe, it, expect, beforeEach } from 'vitest';
import { anomalyToInsight, insightToAnomaly, putInsights, getInsight, getAnomaly, listInsights, putInvestigation, getInvestigation, _clear } from '../../lib/state/insights';
import type { Anomaly, Insight } from '../../lib/mcp/types';

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

// Round-trip contract: insight → anomaly preserves the 4 fields the agent loop
// needs (metric/scope/change/severity) and intentionally drops the rest
// (evidence/impact/history/category). Pins the silent-drop decision so the
// next person to add a field to Anomaly has a forcing function.
describe('Insight ↔ Anomaly round-trip', () => {
  const sample: Insight = {
    id: 'insight-1',
    timestamp: '2026-06-04T00:00:00.000Z',
    severity: 'warning',
    headline: 'mobile checkout conversion_rate · -18%',
    summary: 'conversion_rate down 18% vs 7d',
    metric: 'conversion_rate',
    change: { value: -18, direction: 'down', baseline: '7d' },
    scope: ['mobile', 'checkout'],
    source: 'monitoring',
    evidence: [{ tool: 'execute_analytics_eql', result: { current: 0.082, prior: 0.1 } }],
    impact: 'Conversion is the funnel hinge — an 18% drop loses orders even at flat traffic.',
    history: [0.1, 0.099, 0.098, 0.095, 0.094, 0.093, 0.092, 0.09, 0.088, 0.086, 0.084, 0.082],
    category: 'conversion_drop',
  };

  it('preserves metric/scope/change/severity through insight → anomaly', () => {
    const anomaly = insightToAnomaly(sample);
    expect(anomaly.metric).toBe(sample.metric);
    expect(anomaly.scope).toBe(sample.scope);
    expect(anomaly.change).toBe(sample.change);
    expect(anomaly.severity).toBe(sample.severity);
  });

  it('intentionally drops evidence on insight → anomaly', () => {
    const anomaly = insightToAnomaly(sample);
    expect(anomaly.evidence).toEqual([]); // explicit empty, not the source's evidence
  });

  it('intentionally drops impact on insight → anomaly', () => {
    const anomaly = insightToAnomaly(sample);
    expect(anomaly.impact).toBeUndefined();
  });

  it('intentionally drops history on insight → anomaly', () => {
    const anomaly = insightToAnomaly(sample);
    expect(anomaly.history).toBeUndefined();
  });

  it('intentionally drops category on insight → anomaly', () => {
    const anomaly = insightToAnomaly(sample);
    expect(anomaly.category).toBeUndefined();
  });
});
