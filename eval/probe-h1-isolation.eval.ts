// eval/probe-h1-isolation.eval.ts
//
// H1 isolation probe for the multi-agent coordination-failure drill
// (.aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md
// Step 2.4).
//
// Hypothesis under test:
//   The recommendation agent generates a rec targeting a hypothesis that the
//   diagnosis explicitly marked `supported: false`. The handoff shape carries
//   the rejection but the rec agent doesn't respect it.
//
// The probe:
//   Feed the recommendation agent a hand-built Diagnosis whose
//   `hypothesesConsidered` array contains ONLY the primary payment-failure
//   hypothesis with `supported: true`. No rejected entries. If the rec agent
//   STILL produces a rec targeting the CTA experiment (or any other rejected
//   concern), H1 is refuted — the mechanism is upstream of the handoff shape
//   (probably in the rec agent's own prompt). If the rec agent produces recs
//   scoped tightly to payment failure, H1 is confirmed.
//
// Runs 3 times against case 08's anomaly for reproducibility.
//
// ─── Pattern: controlled isolation experiment (systematic debugging) ──────
// A debugging probe, NOT a scored eval. Feeds the rec agent a hand-built,
// single-hypothesis diagnosis to ISOLATE one variable and confirm/refute a
// named hypothesis (H1) about where a coordination failure originates. The
// controlled-experiment / minimal-repro pattern: hold everything fixed, vary
// one input, observe the output. Sub-patterns: repeat N times (runs 1–3) to
// check reproducibility, and fingerprint the output to .aipe/drills for the
// drill record. Ungated (no skipIf) — it's run by hand during a drill, not CI.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { beforeAll, describe, it } from 'vitest';

import { RecommendationAgent } from '../lib/agents/recommendation';
import {
  SyntheticDataSource,
  syntheticWorkspaceSchema,
} from '../lib/data-source/synthetic-data-source';
import type { McpToolDef } from '../lib/agents/tool-schemas';
import type { Anomaly, Diagnosis } from '../lib/mcp/types';
import { goldens } from './goldens';

// Load .env.local so ANTHROPIC_API_KEY is available.
function loadEnv(): void {
  for (const name of ['.env.local', '.env']) {
    try {
      const contents = readFileSync(resolve(process.cwd(), name), 'utf8');
      for (const line of contents.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const key = m[1];
        if (process.env[key]) continue;
        let value = m[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
    } catch {
      /* file missing */
    }
  }
}
loadEnv();

const case08 = goldens.find((g) => g.caseId.startsWith('08-'));
if (!case08) throw new Error('case 08 not found in goldens');

const anomaly: Anomaly = case08.anomaly;

// Hand-built diagnosis: ONE hypothesis, marked supported: true. No rejected
// entries. Same wall-clock affectedCustomers + revenue impact as case 08's
// baseline receipts so the rec agent has the numeric levers to reason with.
const cleanDiagnosis: Diagnosis = {
  conclusion:
    'The 15.8% site-wide checkout completion rate drop is driven by a 31.2% spike in payment failure rate on mobile credit-card transactions, concentrated in SP (São Paulo) mobile sessions, affecting ~1,180 customers and causing ~$18,900 in directly attributable lost revenue. This is the sole confirmed causal driver.',
  evidence: [
    '31.2% surge in credit_card + mobile payment failure rate (0.035 → 0.046).',
    '~1,180 customers directly blocked in SP mobile checkout during the window.',
    'RJ and MG mobile checkout show only marginal change vs SP -24% — SP-specific.',
  ],
  hypothesesConsidered: [
    {
      hypothesis:
        'Mobile credit-card payment failure rate spike (0.035 → 0.046) is the primary and only confirmed driver of the checkout completion rate drop',
      supported: true,
      reasoning:
        'The 31.2% payment failure spike is precisely scoped to credit_card + mobile, matching the concentration of the conversion drop. ~1,180 customers directly blocked, ~$18,900 in blocked revenue. No competing hypothesis is supported.',
    },
  ],
  affectedCustomers: { count: 1180, segmentDescription: 'SP mobile credit-card payment-failure customers' },
};

describe('H1 isolation probe: single-entry hypothesesConsidered', () => {
  let anthropic: Anthropic;
  let allTools: McpToolDef[];
  let dataSource: SyntheticDataSource;

  beforeAll(async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    dataSource = new SyntheticDataSource();
    const listResult = await dataSource.listTools();
    allTools = (listResult as { tools: McpToolDef[] }).tools;
  });

  for (const runIdx of [1, 2, 3]) {
    it(`probe run ${runIdx}: rec agent output vs single-entry diagnosis`, async () => {
      const sessionId = `probe-h1-${Date.now()}-${runIdx}`;
      const recAgent = new RecommendationAgent(
        anthropic,
        dataSource,
        syntheticWorkspaceSchema,
        allTools,
        sessionId,
      );

      const recs = await recAgent.propose(anomaly, cleanDiagnosis, {});

      const outDir = resolve(process.cwd(), '.aipe/drills/fingerprints');
      mkdirSync(outDir, { recursive: true });
      const outPath = resolve(outDir, `probe-h1-run-${runIdx}.json`);
      writeFileSync(
        outPath,
        JSON.stringify(
          {
            runIdx,
            timestamp: new Date().toISOString(),
            diagnosisHandedIn: cleanDiagnosis,
            recommendations: recs.map((r) => ({
              title: r.title,
              rationale: r.rationale,
              bloomreachFeature: r.bloomreachFeature,
            })),
          },
          null,
          2,
        ),
      );
    }, 300_000);
  }
});
