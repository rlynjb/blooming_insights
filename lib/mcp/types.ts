// lib/mcp/types.ts

export type Severity = 'critical' | 'warning' | 'info' | 'positive';

export type AgentName = 'coordinator' | 'monitoring' | 'diagnostic' | 'recommendation';

export interface Insight {
  id: string;
  timestamp: string;
  severity: Severity;
  headline: string;             // "mobile conversion dropped 18%"
  summary: string;              // one-line context
  metric: string;               // "conversion_rate"
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  scope: string[];              // ["mobile", "checkout step"]
  source: 'monitoring' | 'query';
  // how this insight was found: the tool(s) the monitoring agent used and their
  // result (e.g. { current, prior }). Optional — older snapshots lack it.
  evidence?: { tool: string; result: unknown }[];
  // one-sentence business impact, written by the monitoring agent (why this
  // change matters for the business). Optional — older snapshots lack it, so
  // the UI falls back to a derived explanation.
  impact?: string;
  // ── business-owner enrichments (Tier 1). All optional + derived from the
  //    existing evidence, so older snapshots still validate and render. ──
  revenueImpact?: { lostUsd: number; expectedUsd: number; currency: 'USD' }; // for revenue metrics
  aov?: { current: number; prior: number }; // average order value, current vs prior
  funnel?: { view: number; cart: number; checkout: number; purchase: number }; // signed % change vs prior
  affectedCustomers?: number; // denormalized from Diagnosis.affectedCustomers.count
  history?: number[]; // 12 weekly values, oldest first (Tier 2 sparkline)
  downstreamReady?: { diagnosis: boolean; recommendations: number }; // pre-computed stages
}

export interface ToolCall {
  id: string;
  agent: AgentName;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
  error?: string;
}

export interface ReasoningStep {
  id: string;
  agent: AgentName;
  kind: 'thought' | 'tool_call' | 'hypothesis' | 'conclusion';
  content: string;
  toolCall?: ToolCall;
}

// Monitoring agent output (from spec "monitoring agent" section)
export interface Anomaly {
  metric: string;
  scope: string[];                          // ["mobile", "checkout"]
  change: { value: number; direction: 'up' | 'down'; baseline: string };
  severity: Severity;
  evidence: { tool: string; result: unknown }[];
  impact?: string;                          // one-sentence business impact (agent-written)
  history?: number[];                       // 12 weekly values for the sparkline (agent-emitted)
}

// Diagnostic agent output (from spec "diagnostic agent" section)
export interface Diagnosis {
  conclusion: string;
  evidence: string[];
  hypothesesConsidered: { hypothesis: string; supported: boolean; reasoning: string }[];
  affectedCustomers?: { count: number; segmentDescription: string };
  // confidence in the conclusion, derived from how many hypotheses were tested
  // and supported. Optional — the UI derives it client-side when absent.
  confidence?: 'high' | 'medium' | 'low';
  timeSeries?: { day: string; value: number }[]; // daily metric values (Tier 2 chart)
}

// Recommendation impact — string (legacy snapshots) or a richer shape with a
// dollar range and the assumption that produced it.
export type EstimatedImpact =
  | string
  | { range: string; rangeUsd?: { low: number; high: number }; assumption: string };

// CANONICAL Recommendation shape. NOTE: the spec contains TWO different Recommendation
// definitions (one in "data model", one in "recommendation agent"). Use this RICHER one
// (the recommendation-agent version) everywhere — it has `id`, `steps`, and the 5-member
// `bloomreachFeature` union.
export interface Recommendation {
  id: string;
  title: string;
  rationale: string;
  bloomreachFeature: 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment';
  steps: string[];
  estimatedImpact: EstimatedImpact; // string (legacy) or { range, rangeUsd?, assumption }
  confidence: 'high' | 'medium' | 'low';
  // ── business-owner enrichments (Tier 1). All optional, agent-emitted. ──
  effort?: 'low' | 'medium' | 'high';
  timeToSetUpMinutes?: number;
  readResultInDays?: number;
  prerequisites?: { label: string; satisfied: boolean }[];
  successMetric?: string;
}

export interface Investigation {
  insightId: string;
  reasoning: ReasoningStep[];
  diagnosis: {
    conclusion: string;
    evidence: string[];
    hypothesesConsidered: string[];
  };
  recommendations: Recommendation[];
}
