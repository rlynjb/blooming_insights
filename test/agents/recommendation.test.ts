// test/agents/recommendation.test.ts
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { RecommendationAgent, filterSupportedHypotheses } from '../../lib/agents/recommendation';
import type { McpCaller } from '../../lib/agents/base';
import { AGENT_MODEL } from '../../lib/agents/base';
import type { WorkspaceSchema } from '../../lib/mcp/schema';
import type { McpToolDef } from '../../lib/agents/tool-schemas';
import type { Anomaly, Diagnosis } from '../../lib/mcp/types';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const FIXTURE_SCHEMA: WorkspaceSchema = {
  projectId: 'proj-789',
  projectName: 'Recommendation Store',
  totalCustomers: 30000,
  totalEvents: 7000000,
  oldestTimestamp: new Date('2023-01-01T00:00:00Z').getTime(),
  catalogs: [{ id: 'cat-1', name: 'Products' }],
  events: [
    { name: 'purchase', eventCount: 150000, properties: ['revenue', 'country', 'currency'] },
    { name: 'cart_update', eventCount: 400000, properties: ['product_id', 'quantity'] },
  ],
  customerProperties: ['email', 'country', 'loyalty_tier'],
};

const SAMPLE_ANOMALY: Anomaly = {
  metric: 'conversion_rate',
  scope: ['mobile'],
  change: { value: 23, direction: 'down', baseline: '7d' },
  severity: 'critical',
  evidence: [{ tool: 'execute_analytics_eql', result: { current: 0.03, prior: 0.039 } }],
};

const SAMPLE_DIAGNOSIS: Diagnosis = {
  conclusion: 'Mobile checkout conversion dropped due to a payment UI regression.',
  evidence: ['Mobile purchase count fell 23% while desktop was flat.'],
  hypothesesConsidered: [
    { hypothesis: 'Payment UI regression', supported: true, reasoning: 'Correlates with deploy date.' },
  ],
  affectedCustomers: { count: 1400, segmentDescription: 'Mobile shoppers at checkout' },
};

// ---------------------------------------------------------------------------
// Fake Anthropic builder (same pattern as diagnostic.test.ts)
// ---------------------------------------------------------------------------

type FakeResponse = {
  content: Anthropic.Messages.ContentBlock[];
  stop_reason: Anthropic.Messages.Message['stop_reason'];
};

function buildFakeAnthropic(responses: FakeResponse[]): { anthropic: unknown } {
  let idx = 0;
  const create = vi.fn(async () => {
    const resp = responses[idx];
    if (!resp) throw new Error(`No scripted response at index ${idx}`);
    idx++;
    return {
      id: `msg_${idx}`,
      type: 'message' as const,
      role: 'assistant' as const,
      model: AGENT_MODEL,
      container: null,
      stop_details: null,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        inference_geo: null,
        server_tool_use: null,
        service_tier: null,
      },
      content: resp.content,
      stop_reason: resp.stop_reason,
    } as unknown as Anthropic.Messages.Message;
  });
  return { anthropic: { messages: { create } } };
}

function textBlock(text: string): Anthropic.Messages.ContentBlock {
  return { type: 'text', text, citations: null } as unknown as Anthropic.Messages.ContentBlock;
}

function toolUseBlock(id: string, name: string, input: Record<string, unknown>): Anthropic.Messages.ContentBlock {
  return {
    type: 'tool_use',
    id,
    name,
    input,
    caller: { type: 'direct' },
  } as unknown as Anthropic.Messages.ContentBlock;
}

// ---------------------------------------------------------------------------
// Fake MCP caller
// ---------------------------------------------------------------------------

function buildFakeMcp(): McpCaller {
  return {
    async callTool(_name, _args) {
      return { result: { ok: true }, durationMs: 1, fromCache: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared tool defs
// ---------------------------------------------------------------------------

const FAKE_TOOL_DEFS: McpToolDef[] = [
  {
    name: 'list_scenarios',
    description: 'List existing automation scenarios',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ---------------------------------------------------------------------------
// Valid id-less recommendation array JSON (the agent does NOT emit ids)
// ---------------------------------------------------------------------------

function rec(title: string, feature: string): Record<string, unknown> {
  return {
    title,
    rationale: 'Addresses the mobile checkout regression by re-engaging affected shoppers.',
    bloomreachFeature: feature,
    steps: ['Create a segment', 'Build the action', 'Launch'],
    estimatedImpact: 'Likely recovers ~20% of mobile abandonments.',
    confidence: 'medium',
  };
}

const VALID_RECS_JSON = JSON.stringify([
  rec('Send recovery email to abandoned mobile cart segment', 'scenario'),
  rec('Create a mobile-checkout-abandoners segment', 'segment'),
]);

// 4 recs to exercise the cap-at-3 behaviour
const FOUR_RECS_JSON = JSON.stringify([
  rec('Recovery scenario', 'scenario'),
  rec('Mobile abandoners segment', 'segment'),
  rec('Win-back campaign', 'campaign'),
  rec('Checkout incentive voucher', 'voucher'),
]);

// ---------------------------------------------------------------------------
// 1. Returns recommendations with assigned ids; caps at 3
// ---------------------------------------------------------------------------

describe('RecommendationAgent.propose', () => {
  it('returns recommendations with assigned ids when the agent emits a valid id-less array', async () => {
    const { anthropic } = buildFakeAnthropic([
      { content: [textBlock('```json\n' + VALID_RECS_JSON + '\n```')], stop_reason: 'end_turn' },
    ]);

    const agent = new RecommendationAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.propose(SAMPLE_ANOMALY, SAMPLE_DIAGNOSIS);
    expect(result).toHaveLength(2);
    expect(result[0].bloomreachFeature).toBe('scenario');
    expect(result[1].bloomreachFeature).toBe('segment');
    for (const r of result) {
      expect(typeof r.id).toBe('string');
      expect(r.id.length).toBeGreaterThan(0);
      expect(typeof r.title).toBe('string');
      expect(Array.isArray(r.steps)).toBe(true);
    }
    // ids must be unique
    expect(new Set(result.map((r) => r.id)).size).toBe(result.length);
  });

  it('caps the result at 3 when the agent emits 4 recommendations', async () => {
    const { anthropic } = buildFakeAnthropic([
      { content: [textBlock('```json\n' + FOUR_RECS_JSON + '\n```')], stop_reason: 'end_turn' },
    ]);

    const agent = new RecommendationAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.propose(SAMPLE_ANOMALY, SAMPLE_DIAGNOSIS);
    expect(result).toHaveLength(3);
    expect(result.every((r) => typeof r.id === 'string' && r.id.length > 0)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 2. Passes hooks through (tool call + tool result)
  // ---------------------------------------------------------------------------

  it('fires onToolCall and onToolResult hooks when the script includes a tool_use turn', async () => {
    const { anthropic } = buildFakeAnthropic([
      // Turn 1: agent checks existing scenarios first
      {
        content: [
          toolUseBlock('tu-rec-1', 'list_scenarios', { project_id: 'proj-789' }),
        ],
        stop_reason: 'tool_use',
      },
      // Turn 2: agent emits the valid recommendation array
      {
        content: [textBlock('Considering existing automation…\n```json\n' + VALID_RECS_JSON + '\n```')],
        stop_reason: 'end_turn',
      },
    ]);

    const toolCallsCaptured: string[] = [];
    const mcp: McpCaller = {
      async callTool(name, _args) {
        toolCallsCaptured.push(name);
        return { result: { scenarios: [] }, durationMs: 2, fromCache: false };
      },
    };

    const onToolCall = vi.fn();
    const onText = vi.fn();
    const onToolResult = vi.fn();

    const agent = new RecommendationAgent(
      anthropic as unknown as Anthropic,
      mcp,
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.propose(SAMPLE_ANOMALY, SAMPLE_DIAGNOSIS, { onToolCall, onText, onToolResult });

    expect(toolCallsCaptured).toEqual(['list_scenarios']);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0].id.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Dedicated synthesis salvages recommendations when loop output is unusable
  // ---------------------------------------------------------------------------

  it('synthesizes recommendations when the loop output is unusable', async () => {
    const { anthropic } = buildFakeAnthropic([
      // Loop ends with rambling prose (no valid recommendation JSON)
      { content: [textBlock('Let me think about what to propose — I should check more first.')], stop_reason: 'end_turn' },
      // The dedicated tool-less synthesis call then returns a valid array
      { content: [textBlock('```json\n' + VALID_RECS_JSON + '\n```')], stop_reason: 'end_turn' },
    ]);

    const agent = new RecommendationAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.propose(SAMPLE_ANOMALY, SAMPLE_DIAGNOSIS);
    expect(result).toHaveLength(2);
    expect(result[0].bloomreachFeature).toBe('scenario');
    expect(result.every((r) => typeof r.id === 'string' && r.id.length > 0)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 4. Graceful empty: neither loop nor synthesis yields a valid array
  // ---------------------------------------------------------------------------

  it('resolves to [] when neither the loop nor synthesis yields a valid array', async () => {
    const { anthropic } = buildFakeAnthropic([
      // Loop: one bad (non-recommendation) response
      { content: [textBlock('```json\n{"foo":1}\n```')], stop_reason: 'end_turn' },
      // No second response scripted → the synthesis call hits the empty queue and throws,
      // which synthesize() catches → null. propose() must resolve to [] (not throw).
    ]);

    const agent = new RecommendationAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.propose(SAMPLE_ANOMALY, SAMPLE_DIAGNOSIS);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// filterSupportedHypotheses — coordination-failure fix
//
// The recommendation agent doesn't respect the `supported: false` flag on
// individual hypotheses in the handoff; it treats every entry as a concern to
// address. The 2026-07-03 baseline receipt (case 01 + 08, 6 runs) had 4/6
// producing a rec[2] targeting the rejected `exp-checkout-copy` hypothesis. A
// 3-run H1 isolation probe against a single-entry synthetic diagnosis proved
// the leakage disappears when rejected entries are filtered at the handoff
// boundary. See:
//   .aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md
// ---------------------------------------------------------------------------

describe('filterSupportedHypotheses', () => {
  const baseDiagnosis: Omit<Diagnosis, 'hypothesesConsidered'> = {
    conclusion: 'Payment gateway degradation on mobile checkout in SP.',
    evidence: ['31.2% spike in credit-card payment failure rate on mobile.'],
    affectedCustomers: { count: 1180, segmentDescription: 'SP mobile credit-card customers' },
  };

  it('drops entries with supported: false', () => {
    const diagnosis: Diagnosis = {
      ...baseDiagnosis,
      hypothesesConsidered: [
        { hypothesis: 'Payment gateway failure', supported: true, reasoning: 'Scope + timing match.' },
        { hypothesis: 'Running A/B experiment', supported: false, reasoning: 'Excluded — no variant data.' },
        { hypothesis: 'Broad traffic decline', supported: false, reasoning: 'Other regions flat.' },
      ],
    };

    const out = filterSupportedHypotheses(diagnosis);
    expect(out.hypothesesConsidered).toHaveLength(1);
    expect(out.hypothesesConsidered[0].hypothesis).toBe('Payment gateway failure');
    expect(out.hypothesesConsidered.every((h) => h.supported)).toBe(true);
  });

  it('is a pure copy — does not mutate the input', () => {
    const diagnosis: Diagnosis = {
      ...baseDiagnosis,
      hypothesesConsidered: [
        { hypothesis: 'A', supported: true, reasoning: '.' },
        { hypothesis: 'B', supported: false, reasoning: '.' },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(diagnosis));

    filterSupportedHypotheses(diagnosis);
    expect(diagnosis).toEqual(snapshot);
  });

  it('preserves other Diagnosis fields verbatim', () => {
    const diagnosis: Diagnosis = {
      ...baseDiagnosis,
      hypothesesConsidered: [
        { hypothesis: 'A', supported: true, reasoning: '.' },
      ],
    };
    const out = filterSupportedHypotheses(diagnosis);
    expect(out.conclusion).toBe(diagnosis.conclusion);
    expect(out.evidence).toBe(diagnosis.evidence);
    expect(out.affectedCustomers).toBe(diagnosis.affectedCustomers);
  });

  it('returns an empty array when every hypothesis was rejected (degenerate case)', () => {
    // Not expected in practice — a diagnosis that rejected everything is
    // probably a bug upstream — but the filter shouldn't throw.
    const diagnosis: Diagnosis = {
      ...baseDiagnosis,
      hypothesesConsidered: [
        { hypothesis: 'A', supported: false, reasoning: '.' },
        { hypothesis: 'B', supported: false, reasoning: '.' },
      ],
    };
    const out = filterSupportedHypotheses(diagnosis);
    expect(out.hypothesesConsidered).toEqual([]);
  });

  it('leaves an all-supported diagnosis unchanged', () => {
    const diagnosis: Diagnosis = {
      ...baseDiagnosis,
      hypothesesConsidered: [
        { hypothesis: 'A', supported: true, reasoning: '.' },
        { hypothesis: 'B', supported: true, reasoning: '.' },
      ],
    };
    const out = filterSupportedHypotheses(diagnosis);
    expect(out.hypothesesConsidered).toHaveLength(2);
  });
});
