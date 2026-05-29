import type { Anomaly, Diagnosis, EstimatedImpact, Insight } from '../mcp/types';

/** Normalize an EstimatedImpact (string legacy or rich object) for display. */
export function impactRange(e: EstimatedImpact): string {
  return typeof e === 'string' ? e : e.range;
}
export function impactAssumption(e: EstimatedImpact): string | null {
  return typeof e === 'string' ? null : (e.assumption?.trim() || null);
}

/** Pull the first numeric { current, prior } pair out of an anomaly's evidence. */
function findCurrentPrior(evidence: Anomaly['evidence']): { current: number; prior: number } | null {
  for (const e of evidence ?? []) {
    const r = e?.result as Record<string, unknown> | null;
    if (r && typeof r.current === 'number' && typeof r.prior === 'number') {
      return { current: r.current, prior: r.prior };
    }
  }
  return null;
}

const REVENUE_RE = /revenue|sales|gmv|total_price|spend/i;

/** Business-owner fields derived purely from the evidence the monitoring agent
 *  already computed — no new data. Returns only the fields it can compute; the
 *  UI falls back when a field is absent. */
export function deriveInsightFields(anomaly: Anomaly): Partial<Insight> {
  const out: Partial<Insight> = {};
  const cp = findCurrentPrior(anomaly.evidence);
  if (cp && REVENUE_RE.test(anomaly.metric) && anomaly.change.direction === 'down') {
    // revenue lost this window vs the prior (expected) window
    out.revenueImpact = {
      lostUsd: Math.round(cp.current - cp.prior),
      expectedUsd: Math.round(cp.prior),
      currency: 'USD',
    };
  }
  return out;
}

/** How many hypotheses were actually tested (have reasoning) out of the total. */
export function hypothesesTested(d: Diagnosis): { tested: number; total: number } {
  const h = d.hypothesesConsidered ?? [];
  return {
    tested: h.filter((x) => (x.reasoning ?? '').trim().length > 0).length,
    total: h.length,
  };
}

/** Confidence in a diagnosis, derived from how thoroughly hypotheses were tested
 *  and whether one was supported. Prefers the agent's own `confidence` when set.
 *  high = a hypothesis is supported and all were tested; medium = supported but
 *  some untested (budget / rate limits); low = nothing supported / no hypotheses. */
export function diagnosisConfidence(d: Diagnosis): 'high' | 'medium' | 'low' {
  if (d.confidence) return d.confidence;
  const h = d.hypothesesConsidered ?? [];
  if (h.length === 0) return 'low';
  const supported = h.filter((x) => x.supported).length;
  const { tested, total } = hypothesesTested(d);
  if (supported >= 1 && tested === total) return 'high';
  if (supported >= 1) return 'medium';
  return 'low';
}
