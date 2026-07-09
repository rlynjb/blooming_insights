// lib/agents/recommendation.ts
//
// The recommendation agent — the LAST agent in the diagnose → recommend
// pipeline. Given an anomaly + the diagnostic agent's Diagnosis, it proposes
// the actions a marketer/analyst would actually take.
//
// ─── Pattern: compatibility wrapper (adapter over a reusable agent) ───────
// Blooming owns this thin constructor; @aptkit/core owns the reusable
// AptKitRecommendationAgent. The wrapper adapts Blooming's types into aptkit's
// model / tools / workspace / trace ports via the *Adapter classes, so the
// reusable agent stays domain-agnostic while Blooming keeps a stable call
// site. The tombstone NOTE below is the workshop's "lived receipt" (Move 3):
// a handoff filter that was tried, regressed the eval, and got reverted — the
// answer to "why do you trust the eval?" (workshop Ex 10).
//
import Anthropic from '@anthropic-ai/sdk';
import {
  RecommendationAgent as AptKitRecommendationAgent,
} from '@aptkit/core';
import type { McpCaller } from './base';
import {
  AnthropicModelProviderAdapter,
  BloomingToolRegistryAdapter,
  BloomingTraceSinkAdapter,
} from './aptkit-adapters';
import type { AgentHooks } from './diagnostic';
import type { McpToolDef } from './tool-schemas';
import type { Anomaly, Diagnosis, Recommendation } from '../mcp/types';
import type { WorkspaceSchema } from '../mcp/schema';

// NOTE (2026-07-03): a `filterSupportedHypotheses` helper briefly lived here
// as the coordination-failure drill's Option A. The fingerprint showed 4/6
// runs producing a rec targeting a `supported: false` hypothesis, and the
// isolation probe confirmed removing rejected entries eliminated the
// leakage. But the follow-up 10-case eval showed the fix regressed all four
// recommendation-quality dimensions by 13–23pp (case-matched, n=15). Reason:
// the rejected hypotheses carry load-bearing context the rec agent uses to
// shape its recs — "we ruled X out because Y" tells the rec agent both what
// to avoid AND why the primary is primary. The filter stripped that
// context. Reverted. See:
//   .aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md

/** Compatibility wrapper: Blooming keeps this constructor while AptKit owns the reusable agent. */
export class RecommendationAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}

  async propose(
    anomaly: Anomaly,
    diagnosis: Diagnosis,
    hooks: AgentHooks = {},
  ): Promise<Recommendation[]> {
    const agent = new AptKitRecommendationAgent({
      model: new AnthropicModelProviderAdapter(
        this.anthropic,
        'recommendation',
        this.sessionId,
        undefined,
        undefined,
        hooks.budget,
      ),
      tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
      workspace: this.schema,
      trace: new BloomingTraceSinkAdapter(hooks, 'recommendation'),
    });

    return agent.propose(anomaly, diagnosis, { signal: hooks.signal });
  }
}
