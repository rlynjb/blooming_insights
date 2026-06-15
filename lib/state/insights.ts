import type { Anomaly, Insight, Investigation } from '../mcp/types';
import { deriveInsightFields } from '../insights/derive';

// Session-scoped feed state. A single warm Vercel instance serves many users
// concurrently, so module-level Maps would bleed between sessions — and
// putInsights' clear() would wipe another user's feed mid-briefing. Each
// session gets its own sub-feed; the outer map is never cleared by a request.
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};

const state = new Map<string, SessionFeed>();

function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}

export function anomalyToInsight(a: Anomaly): Insight {
  const id = crypto.randomUUID();
  const sign = a.change.direction === 'down' ? '-' : '+';
  const headline = `${a.scope.join(' ')} ${a.metric} · ${sign}${Math.abs(a.change.value)}%`.toLowerCase();
  return {
    id,
    timestamp: new Date().toISOString(),
    severity: a.severity,
    headline,
    summary: `${a.metric} ${a.change.direction} ${Math.abs(a.change.value)}% vs ${a.change.baseline}`.toLowerCase(),
    metric: a.metric,
    change: a.change,
    scope: a.scope,
    source: 'monitoring',
    evidence: a.evidence, // tool(s) + result that produced this insight
    impact: a.impact, // agent's one-sentence business impact (why it matters)
    history: a.history, // weekly series for the sparkline (when the agent emitted one)
    category: a.category, // coverage-grid category this anomaly fired (when stamped)
    ...deriveInsightFields(a), // business-owner fields derived from the evidence
  };
}

/**
 * Reverse mapper. Intentionally drops evidence/impact/history/category —
 * the agent loop only needs metric/scope/change/severity to investigate;
 * the rest is regenerated downstream. The dropped fields are tested in
 * test/state/insights.test.ts (round-trip suite).
 */
export function insightToAnomaly(i: Insight): Anomaly {
  return { metric: i.metric, scope: i.scope, change: i.change, severity: i.severity, evidence: [] };
}

export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  // Replace the previous briefing for THIS session — each run IS the current
  // feed, not an addition. Without clearing, a warm serverless instance (or a
  // long-running dev server) accumulates stale insights from earlier runs, so
  // the feed shows yesterday's anomalies alongside today's. Investigations are
  // keyed separately and untouched here. Only this session's sub-maps are
  // cleared — never the outer map, never another session's feed.
  const s = sessionState(sessionId);
  s.insights.clear();
  s.anomalies.clear();
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}

export function getInsight(sessionId: string, id: string): Insight | null {
  return state.get(sessionId)?.insights.get(id) ?? null;
}

export function getAnomaly(sessionId: string, id: string): Anomaly | null {
  return state.get(sessionId)?.anomalies.get(id) ?? null;
}

export function listInsights(sessionId: string): Insight[] {
  const s = state.get(sessionId);
  return s ? [...s.insights.values()] : [];
}

export function putInvestigation(sessionId: string, inv: Investigation): void {
  sessionState(sessionId).investigations.set(inv.insightId, inv);
}

export function getInvestigation(sessionId: string, id: string): Investigation | null {
  return state.get(sessionId)?.investigations.get(id) ?? null;
}

/** test-only — when sessionId is omitted, wipe the entire outer map. */
export function _clear(sessionId?: string): void {
  if (sessionId === undefined) {
    state.clear();
    return;
  }
  state.delete(sessionId);
}
