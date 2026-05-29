// Backfill the demo snapshot's insights with the business-owner enrichment
// fields that are DERIVABLE from the already-captured investigations — no
// fabricated data:
//   - affectedCustomers: the diagnosis's affectedCustomers.count (when > 0)
//   - downstreamReady:   { diagnosis, recommendations } from the cached events
//
// (revenueImpact / aov / funnel are derived live by anomalyToInsight from the
// monitoring evidence and only land in the demo after a fresh capture of an
// insight whose evidence carries them — they're left absent here, not invented.)
//
// Run: node scripts/backfill-demo-enrichment.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const INS = join(ROOT, 'lib/state/demo-insights.json');
const snap = JSON.parse(readFileSync(INS, 'utf8'));
const inv = JSON.parse(readFileSync(join(ROOT, 'lib/state/demo-investigations.json'), 'utf8'));

for (const i of snap.insights) {
  const ev = inv[i.id] || [];
  const diag = ev.find((e) => e.type === 'diagnosis')?.diagnosis;
  const recs = ev.filter((e) => e.type === 'recommendation').length;
  const affected = diag?.affectedCustomers?.count;
  if (typeof affected === 'number' && affected > 0) i.affectedCustomers = affected;
  if (ev.length) i.downstreamReady = { diagnosis: !!diag, recommendations: recs };
}

writeFileSync(INS, JSON.stringify(snap, null, 2) + '\n');
console.log(`backfilled ${snap.insights.length} insights → lib/state/demo-insights.json`);
for (const i of snap.insights) {
  console.log(`  ${i.metric.padEnd(28)} affectedCustomers=${i.affectedCustomers ?? '—'} downstreamReady=${JSON.stringify(i.downstreamReady)}`);
}
