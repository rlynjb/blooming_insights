import type { Anomaly, Insight, Investigation } from '../mcp/types';
import { deriveInsightFields } from '../insights/derive';

const insights = new Map<string, Insight>();
const investigations = new Map<string, Investigation>();
const anomalies = new Map<string, Anomaly>();

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
    ...deriveInsightFields(a), // business-owner fields derived from the evidence
  };
}

export function putInsights(items: Insight[], rawAnomalies?: Anomaly[]): void {
  // Replace the previous briefing — each run IS the current feed, not an
  // addition. Without clearing, a warm serverless instance (or a long-running
  // dev server) accumulates stale insights from earlier runs, so the feed shows
  // yesterday's anomalies alongside today's. Investigations are keyed separately
  // and untouched here.
  insights.clear();
  anomalies.clear();
  items.forEach((i, idx) => {
    insights.set(i.id, i);
    if (rawAnomalies?.[idx]) anomalies.set(i.id, rawAnomalies[idx]);
  });
}

export function getInsight(id: string): Insight | null {
  return insights.get(id) ?? null;
}

export function getAnomaly(id: string): Anomaly | null {
  return anomalies.get(id) ?? null;
}

export function listInsights(): Insight[] {
  return [...insights.values()];
}

export function putInvestigation(inv: Investigation): void {
  investigations.set(inv.insightId, inv);
}

export function getInvestigation(id: string): Investigation | null {
  return investigations.get(id) ?? null;
}

export function _clear(): void {
  insights.clear();
  investigations.clear();
  anomalies.clear();
}
