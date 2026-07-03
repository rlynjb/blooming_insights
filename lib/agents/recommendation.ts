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

/**
 * Strip `supported: false` entries from a Diagnosis's `hypothesesConsidered`
 * before handing it to the recommendation agent.
 *
 * Why: the recommendation agent doesn't respect the `supported` flag on
 * individual hypotheses — it treats every entry in the array as "a concern
 * worth addressing" and produces a recommendation for each. When the
 * diagnostic agent correctly rejects a hypothesis (`supported: false`), that
 * rejection leaks through as a recommendation targeting the rejected cause.
 *
 * The 2026-07-03 baseline (`eval/baseline.json`, runId `T04-08-28`) showed
 * this pattern: 4/6 runs across cases 01+08 produced a rec[2] targeting the
 * `exp-checkout-copy` hypothesis that the diagnosis had marked
 * `supported: false`. All 4 failed the recommendation-quality rubric's
 * `diagnosis_response` dimension with the judge language "pursues the one
 * hypothesis the diagnosis rejected for lack of evidence."
 *
 * A 3-run H1 isolation probe (`.aipe/drills/fingerprints/probe-h1-run-*.json`)
 * confirmed that removing rejected entries at the handoff boundary eliminates
 * the leakage — 0/3 probe runs produced a rec targeting the rejected
 * hypothesis when it was absent from the handoff.
 *
 * The residual "always produce an A/B experiment as rec[2]" bias in the
 * recommendation agent is structural (see the drill writeup at
 * `.aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md`);
 * this fix removes the temptation, not the bias.
 */
export function filterSupportedHypotheses(diagnosis: Diagnosis): Diagnosis {
  return {
    ...diagnosis,
    hypothesesConsidered: diagnosis.hypothesesConsidered.filter((h) => h.supported),
  };
}

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
    // Filter rejected hypotheses at the handoff boundary — see
    // `filterSupportedHypotheses` above for the receipt.
    const filteredDiagnosis = filterSupportedHypotheses(diagnosis);

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

    return agent.propose(anomaly, filteredDiagnosis, { signal: hooks.signal });
  }
}
