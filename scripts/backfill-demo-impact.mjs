// One-time backfill: the demo snapshot (lib/state/demo-insights.json) was
// captured before the monitoring agent emitted a per-anomaly `impact`. This
// script writes that field for each demo insight using the SAME model the live
// agent uses (claude-sonnet-4-6) and the SAME business-impact instruction, run
// against the snapshot's REAL change data — so demo shows agent-generated
// business impact identical in kind to live. It invents no numbers: only the
// metric, magnitude, direction, baseline, severity and scope already in the
// snapshot are given to the model.
//
// A fresh live capture (the dev "capture demo snapshot" button) supersedes this
// — the live agent's own impact is written verbatim into the snapshot.
//
// Run: node scripts/backfill-demo-impact.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const ROOT = process.cwd();

// load ANTHROPIC_API_KEY from .env.local (not loaded automatically by node)
function loadKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const env = readFileSync(join(ROOT, '.env.local'), 'utf8');
    const m = env.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    /* ignore */
  }
  throw new Error('ANTHROPIC_API_KEY not found (env or .env.local)');
}

const FILE = join(ROOT, 'lib/state/demo-insights.json');
const snap = JSON.parse(readFileSync(FILE, 'utf8'));
const ws = snap.workspace ?? {};
const anthropic = new Anthropic({ apiKey: loadKey() });

const system =
  `You are the monitoring agent in blooming insights, an AI analyst for Bloomreach Engagement. ` +
  `Workspace "${ws.projectName ?? 'this workspace'}"` +
  (ws.totalCustomers ? ` — ${ws.totalCustomers.toLocaleString()} customers, ${(ws.totalEvents ?? 0).toLocaleString()} events.` : '.') +
  `\n\nGiven ONE detected metric change, write TWO things as JSON:\n` +
  `- "impact": ONE plain-language sentence on the BUSINESS IMPACT RIGHT NOW — what the change means ` +
  `for the business and why the user should care, specific to the metric and magnitude (translate to ` +
  `revenue / customers / funnel consequences). Do NOT just restate the percentage. ≤ ~40 words.\n` +
  `- "outlook": ONE FORWARD-LOOKING sentence — what happens in the near term IF this trend continues ` +
  `(projected direction/magnitude and the downstream metric it drags), framed conditionally ` +
  `("if this holds…"). Distinct from impact. ≤ ~35 words.\n` +
  `Output ONLY a JSON object {"impact": "...", "outlook": "..."} — no markdown, no preamble.`;

const detailFor = async (i) => {
  const user =
    `Metric: ${i.metric}\n` +
    `Scope: ${(i.scope ?? []).join(', ') || 'global'}\n` +
    `Change: ${i.change.direction} ${i.change.value}% vs the prior ${i.change.baseline}\n` +
    `Severity: ${i.severity}`;
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content.find((b) => b.type === 'text')?.text ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  const obj = m ? JSON.parse(m[0]) : {};
  return { impact: (obj.impact ?? '').trim(), outlook: (obj.outlook ?? '').trim() };
};

for (const i of snap.insights) {
  const { impact, outlook } = await detailFor(i);
  i.impact = impact;
  i.outlook = outlook;
  console.log(`• ${i.metric} (${i.severity})\n    impact:  ${impact}\n    outlook: ${outlook}`);
}

writeFileSync(FILE, JSON.stringify(snap, null, 2) + '\n');
console.log(`\n✓ wrote impact + outlook for ${snap.insights.length} insights → lib/state/demo-insights.json`);
