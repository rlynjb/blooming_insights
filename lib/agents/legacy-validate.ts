import type { Anomaly, Severity, Diagnosis, Recommendation } from '../mcp/types';

export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    // Fall through to substring scan.
  }
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  }
  throw new Error('no parseable json in agent output');
}

const SEVERITIES: Severity[] = ['critical', 'warning', 'info', 'positive'];

export function isAnomalyArray(value: unknown): value is Anomaly[] {
  return Array.isArray(value) && value.every((candidate) => {
    if (!isRecord(candidate)) return false;
    const change = candidate.change;
    return typeof candidate.metric === 'string' &&
      Array.isArray(candidate.scope) &&
      isRecord(change) &&
      typeof change.value === 'number' &&
      (change.direction === 'up' || change.direction === 'down') &&
      typeof change.baseline === 'string' &&
      SEVERITIES.includes(candidate.severity as Severity);
  });
}

export function isDiagnosis(value: unknown): value is Diagnosis {
  if (!isRecord(value)) return false;
  return typeof value.conclusion === 'string' &&
    Array.isArray(value.evidence) &&
    Array.isArray(value.hypothesesConsidered);
}

const FEATURES = ['scenario', 'segment', 'campaign', 'voucher', 'experiment'];
const CONFIDENCE = ['high', 'medium', 'low'];

// The legacy recommendation agent emits recommendations without ids; the
// system assigns ids after validation.
export function isRecommendationArray(value: unknown): value is Omit<Recommendation, 'id'>[] {
  return Array.isArray(value) && value.every((candidate) => {
    if (!isRecord(candidate)) return false;
    const estimatedImpact = candidate.estimatedImpact;
    const impactOk = typeof estimatedImpact === 'string' ||
      (isRecord(estimatedImpact) && typeof estimatedImpact.range === 'string');

    return typeof candidate.title === 'string' &&
      typeof candidate.rationale === 'string' &&
      FEATURES.includes(candidate.bloomreachFeature as string) &&
      Array.isArray(candidate.steps) &&
      impactOk &&
      CONFIDENCE.includes(candidate.confidence as string);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
