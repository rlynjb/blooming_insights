import type { Anomaly, Severity, Diagnosis, Recommendation } from './types';

export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through to substring scan */ }
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error('no parseable json in agent output');
}

const SEVERITIES: Severity[] = ['critical', 'warning', 'info', 'positive'];

export function isAnomalyArray(v: unknown): v is Anomaly[] {
  return Array.isArray(v) && v.every((a) =>
    !!a && typeof a === 'object' &&
    typeof (a as any).metric === 'string' &&
    Array.isArray((a as any).scope) &&
    !!(a as any).change && typeof (a as any).change.value === 'number' &&
    ((a as any).change.direction === 'up' || (a as any).change.direction === 'down') &&
    typeof (a as any).change.baseline === 'string' &&
    SEVERITIES.includes((a as any).severity)
  );
}

export function isDiagnosis(v: unknown): v is Diagnosis {
  if (!v || typeof v !== 'object') return false;
  const d = v as any;
  return typeof d.conclusion === 'string'
    && Array.isArray(d.evidence)
    && Array.isArray(d.hypothesesConsidered);
}

const FEATURES = ['scenario', 'segment', 'campaign', 'voucher', 'experiment'];
const CONFIDENCE = ['high', 'medium', 'low'];

// The agent emits recommendations WITHOUT an `id` (the system assigns ids after
// validation), so we validate the array of the id-less shape.
export function isRecommendationArray(v: unknown): v is Omit<Recommendation, 'id'>[] {
  return Array.isArray(v) && v.every((r) => {
    const x = r as any;
    return !!x && typeof x === 'object'
      && typeof x.title === 'string'
      && typeof x.rationale === 'string'
      && FEATURES.includes(x.bloomreachFeature)
      && Array.isArray(x.steps)
      && typeof x.estimatedImpact === 'string'
      && CONFIDENCE.includes(x.confidence);
  });
}
