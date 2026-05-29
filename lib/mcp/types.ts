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
  // one-sentence forward-looking outlook: what happens in the near term if the
  // trend continues. Optional — UI derives a fallback when absent.
  outlook?: string;
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
  outlook?: string;                         // one-sentence forward-looking outlook (agent-written)
}

// Diagnostic agent output (from spec "diagnostic agent" section)
export interface Diagnosis {
  conclusion: string;
  evidence: string[];
  hypothesesConsidered: { hypothesis: string; supported: boolean; reasoning: string }[];
  affectedCustomers?: { count: number; segmentDescription: string };
}

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
  estimatedImpact: string;
  confidence: 'high' | 'medium' | 'low';
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
