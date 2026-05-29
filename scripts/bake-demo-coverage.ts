// One-off: bake a `coverage` report into the committed demo snapshot so the
// coverage grid renders in demo mode. Computed by the REAL gate (coverageReport)
// over wobbly-ukulele's real event set — no hand-written resolutions. A fresh
// live capture (with the categorized monitoring agent) supersedes this and also
// stamps each insight with its `category` so the firing tiles light up.
//
// Run: npx tsx scripts/bake-demo-coverage.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverageReport } from '../lib/agents/categories';

// wobbly-ukulele emits these events (no utm_source property / no inventory
// catalog captured → campaign_perf + inventory resolve to "limited"; search /
// return / payment_failure absent → those three are "unavailable").
const events = new Set<string>(['view_item', 'cart_update', 'checkout', 'session_start', 'purchase']);
const coverage = coverageReport(events);

const file = join(process.cwd(), 'lib/state/demo-insights.json');
const snap = JSON.parse(readFileSync(file, 'utf8'));
snap.coverage = coverage;
writeFileSync(file, JSON.stringify(snap, null, 2) + '\n');

console.log(`baked coverage into demo-insights.json (${coverage.length} categories):`);
for (const c of coverage) console.log(`  ${c.category.padEnd(18)} ${c.coverage}${c.missing ? ` · missing ${c.missing.join(', ')}` : ''}`);
