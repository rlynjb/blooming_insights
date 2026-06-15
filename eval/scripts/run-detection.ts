// eval/scripts/run-detection.ts
//
// PR D entry point — run K iterations of MonitoringAgent.scan() against the
// live OlistDataSource, score each run's emitted anomalies against the 3
// seeded anomalies, aggregate, write JSON + summary.md to disk.
//
// Usage:
//   npm run eval:detection -- --K=10
//
// Cost: ~$1-3 in Anthropic spend on K=10 with Sonnet 4.6.
// Runtime: ~5-10 minutes (sequential — each run spawns a fresh subprocess to
// guarantee per-run isolation).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { runMonitoringAgentOnce } from './lib/run-agent';
import { scoreRun, strictMatchesFor, type SeededAnomaly } from './lib/scorer';
import { aggregate, renderSummaryMarkdown, type PerRunScore } from './lib/summary';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

// .env.local is where the project keeps ANTHROPIC_API_KEY; Next.js loads it
// automatically at the route layer, but the standalone tsx runner has no such
// magic. We tolerate KEY=value and KEY="value" / KEY='value' lines, ignore
// comments + blank lines, and skip lines whose key is already in the env.
function loadEnvLocal(): void {
  const envPath = resolve(REPO_ROOT, '.env.local');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
loadEnvLocal();

// ---------------------------------------------------------------------------
// CLI parsing — only `--K=<n>` is supported per the plan. Default K=10.
// ---------------------------------------------------------------------------
function parseK(): number {
  const arg = process.argv.find((a) => a.startsWith('--K='));
  if (!arg) return 10;
  const n = Number(arg.slice('--K='.length));
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --K value: ${arg}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Load seeded anomalies from the SQLite DB the mcp-server-olist seeded.
// ---------------------------------------------------------------------------
function loadSeededAnomalies(): SeededAnomaly[] {
  const dbPath = resolve(REPO_ROOT, 'mcp-server-olist/data/olist.db');
  if (!existsSync(dbPath)) {
    throw new Error(
      `Olist DB not found at ${dbPath}. Run 'cd mcp-server-olist && npm run seed' first.`,
    );
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT * FROM seeded_anomalies ORDER BY id').all() as SeededAnomaly[];
    return rows;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Build the date-stamped results dir. Returns the absolute path.
// ---------------------------------------------------------------------------
function makeResultsDir(): { dir: string; date: string } {
  const today = new Date();
  const date = today.toISOString().slice(0, 10);
  // EVAL_RUN_TAG lets a same-day re-run land in a sibling dir (e.g.
  // `2026-06-15-after-fix/`) instead of overwriting the prior run's
  // summary.md and raw audit trail.
  const tag = process.env.EVAL_RUN_TAG;
  const dirName = tag ? `${date}-${tag}` : date;
  const dir = resolve(REPO_ROOT, 'eval/results', dirName);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return { dir, date };
}

// ---------------------------------------------------------------------------
// Progress logger — one line per run.
// ---------------------------------------------------------------------------
function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'ANTHROPIC_API_KEY not set. Add it to .env.local and re-run.',
    );
    process.exit(1);
  }

  const K = parseK();
  const anomalies = loadSeededAnomalies();
  if (anomalies.length === 0) {
    console.error('No seeded anomalies in DB. Re-seed mcp-server-olist.');
    process.exit(1);
  }
  console.log(
    `[detection] starting K=${K} runs against ${anomalies.length} seeded anomalies`,
  );
  console.log(`[detection] anomalies: ${anomalies.map((a) => a.id).join(', ')}`);

  const t0 = Date.now();
  const perRun: PerRunScore[] = [];
  const sessionId = `eval-detection-${Date.now()}`;

  for (let i = 1; i <= K; i++) {
    const capture = await runMonitoringAgentOnce(i, `${sessionId}-run${i}`);
    const score = scoreRun(capture.insights, anomalies);
    perRun.push({
      runIndex: capture.runIndex,
      durationMs: capture.durationMs,
      error: capture.error,
      insights: capture.insights,
      score,
      toolCalls: capture.toolCalls.map((tc) => ({ toolName: tc.toolName, args: tc.args })),
      reasoning: capture.reasoning,
    });

    const durSec = (capture.durationMs / 1000).toFixed(0);
    if (capture.error) {
      console.log(
        `[K=${K}] run ${i}/${K} ERRORED in ${durSec}s → ${capture.error}`,
      );
    } else {
      console.log(
        `[K=${K}] run ${i}/${K} done in ${durSec}s ` +
          `(loose P=${fmtPct(score.loose.precision)} R=${fmtPct(score.loose.recall)}; ` +
          `strict P=${fmtPct(score.strict.precision)} R=${fmtPct(score.strict.recall)}; ` +
          `insights=${capture.insights.length})`,
      );
    }
  }

  const totalSeconds = (Date.now() - t0) / 1000;
  const summary = aggregate(perRun, anomalies);

  const { dir, date } = makeResultsDir();
  const looseOut = {
    K,
    date,
    mode: 'loose',
    aggregate: summary.loose,
    per_anomaly: summary.per_anomaly_loose,
    runs: perRun.map((r) => ({
      runIndex: r.runIndex,
      durationMs: r.durationMs,
      error: r.error,
      score: {
        truePositives: r.score.loose.truePositives,
        falsePositives: r.score.loose.falsePositives,
        falseNegatives: r.score.loose.falseNegatives,
        precision: r.score.loose.precision,
        recall: r.score.loose.recall,
      },
      matches: r.score.matches.map((m) => ({
        insight_idx: m.insight_idx,
        anomaly_id: m.anomaly_id,
        matched_criteria: m.matched_criteria,
        is_loose_match: m.is_loose_match,
      })),
    })),
  };

  const strictOut = {
    K,
    date,
    mode: 'strict',
    aggregate: summary.strict,
    per_anomaly: summary.per_anomaly_strict,
    runs: perRun.map((r) => {
      const strictMatches = strictMatchesFor(r.insights, anomalies);
      return {
        runIndex: r.runIndex,
        durationMs: r.durationMs,
        error: r.error,
        score: {
          truePositives: r.score.strict.truePositives,
          falsePositives: r.score.strict.falsePositives,
          falseNegatives: r.score.strict.falseNegatives,
          precision: r.score.strict.precision,
          recall: r.score.strict.recall,
        },
        matches: strictMatches.map((m) => ({
          insight_idx: m.insight_idx,
          anomaly_id: m.anomaly_id,
          matched_criteria: m.matched_criteria,
          is_strict_match: m.is_strict_match,
        })),
      };
    }),
  };

  // Raw insights + tool-call args for audit (NO tool results — those can be
  // tens of KB per call and inflate the file). The auditor can re-run a single
  // call manually if they want the underlying numbers.
  const rawOut = {
    K,
    date,
    sessionId,
    runs: perRun.map((r) => ({
      runIndex: r.runIndex,
      durationMs: r.durationMs,
      error: r.error,
      insights: r.insights,
      // Tool calls (args only — results omitted to keep the file readable)
      // surfaced so we can debug "why did this run emit []?".
      toolCalls: r.toolCalls,
      reasoning: r.reasoning,
    })),
  };

  writeFileSync(
    resolve(dir, `detection-K${K}-loose.json`),
    JSON.stringify(looseOut, null, 2),
  );
  writeFileSync(
    resolve(dir, `detection-K${K}-strict.json`),
    JSON.stringify(strictOut, null, 2),
  );
  writeFileSync(
    resolve(dir, `detection-K${K}-raw.json`),
    JSON.stringify(rawOut, null, 2),
  );

  const md = renderSummaryMarkdown({
    date,
    K,
    summary,
    anomalies,
    totalRuntimeSeconds: totalSeconds,
  });
  writeFileSync(resolve(dir, 'summary.md'), md);

  console.log('');
  console.log(`[detection] wrote results to ${dir}`);
  console.log(md);
}

main().catch((err) => {
  console.error('[detection] fatal:', err);
  process.exit(1);
});
