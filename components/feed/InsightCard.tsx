import Link from 'next/link';
import type { Insight } from '@/lib/mcp/types';
import SeverityBadge from './SeverityBadge';

interface InsightCardProps {
  insight: Insight;
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString().toLowerCase();
  } catch {
    return ts.toLowerCase();
  }
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

/** "90d" → "90 days", "7d" → "7 days", else the raw baseline. */
function humanizeBaseline(b: string): string {
  const m = b.match(/^(\d+)\s*d$/i);
  return m ? `${m[1]} days` : b;
}

/** Why this change matters — the metric's business role (inferred from its
 *  name) plus the urgency its severity implies. Explains the real data the
 *  agent recorded; invents nothing. */
function whyItMatters(insight: Insight): string {
  const m = insight.metric.toLowerCase();
  let role: string;
  if (/revenue|purchase|sales|order|spend|aov|ltv|gmv/.test(m))
    role = 'a top-line revenue metric — a move here flows straight to income';
  else if (/conversion|checkout|cart|funnel|abandon/.test(m))
    role = 'a funnel metric — it tracks how efficiently visits turn into orders';
  else if (/session|traffic|visit|view|reach|impression|open|click|ctr/.test(m))
    role = 'a top-of-funnel volume metric — it shapes how many people enter the funnel';
  else if (/retention|churn|repeat|return|reactivat|loyal/.test(m))
    role = 'a retention metric — it reflects whether customers come back';
  else if (/email|campaign|message|push|notif/.test(m))
    role = 'an engagement metric — it tracks how customers respond to your messaging';
  else role = 'a tracked workspace metric';

  let urgency: string;
  switch (insight.severity) {
    case 'critical':
      urgency = 'flagged critical — the most significant change in this briefing, so look here first';
      break;
    case 'warning':
      urgency = 'flagged a warning — notable and worth a look before it compounds';
      break;
    case 'positive':
      urgency = 'a positive move — worth understanding what drove it so you can repeat it';
      break;
    default:
      urgency = 'smaller, but notable enough to surface';
  }
  return `this is ${role}. it's ${urgency}.`;
}

/** Why the card carries the scope it does. The monitor measures globally first
 *  and only breaks a change down by segment when it's large enough to localize,
 *  so a country tag means the shift is concentrated there. */
function scopeExplain(insight: Insight): string {
  const segs = insight.scope.filter((s) => s.toLowerCase() !== 'global');
  if (segs.length === 0) {
    return 'measured across your entire workspace — no single country or segment stood out, so this is a workspace-wide move.';
  }
  return `localized to ${segs.join(' / ')} — the change is concentrated there, not workspace-wide. the monitor breaks a metric down by segment only when the shift is large enough to pin to one.`;
}

/** Forward-looking outlook — a conditional projection of where this heads if the
 *  trend holds. Used when the agent didn't write an `outlook` (demo / older
 *  snapshots). Honest: it's an explicit "if this continues" projection derived
 *  from the real direction + metric, not a claimed fact. */
function forecastText(insight: Insight): string {
  if (insight.severity === 'positive') {
    return 'if this holds, the gain compounds into the next period — confirm what is driving it so you can sustain it.';
  }
  const m = insight.metric.toLowerCase();
  const downstream = /revenue|purchase|sales|order|spend|aov|ltv|gmv/.test(m)
    ? 'revenue keeps eroding'
    : /conversion|checkout|cart|funnel|abandon/.test(m)
      ? 'fewer visits turn into orders'
      : /session|traffic|visit|view|reach|impression|open|click|ctr/.test(m)
        ? 'the top of the funnel keeps shrinking'
        : /retention|churn|repeat|return|reactivat|loyal/.test(m)
          ? 'more customers lapse'
          : 'the metric keeps drifting';
  const move = insight.change.direction === 'down' ? 'the shortfall widens' : 'the change accelerates';
  return `if the trend holds, expect ${move} next period and ${downstream} — best caught before it compounds.`;
}

/** Pull the provenance the monitoring agent recorded for this insight: which
 *  tool(s) ran, and the current vs prior values behind the change (when the
 *  evidence carries them). */
function readEvidence(insight: Insight): { tools: string[]; current?: number; prior?: number } {
  const ev = insight.evidence ?? [];
  const tools = [...new Set(ev.map((e) => e?.tool).filter((t): t is string => !!t))];
  let current: number | undefined;
  let prior: number | undefined;
  for (const e of ev) {
    const r = e?.result as { current?: unknown; prior?: unknown } | null;
    if (r && typeof r.current === 'number' && typeof r.prior === 'number') {
      current = r.current;
      prior = r.prior;
      break;
    }
  }
  return { tools, current, prior };
}

export default function InsightCard({ insight }: InsightCardProps) {
  const prov = readEvidence(insight);
  const hasComparison = prov.current !== undefined && prov.prior !== undefined;
  const dirColor =
    insight.change.direction === 'down' ? 'var(--accent-coral)' : 'var(--accent-teal)';
  const abs = Math.abs(insight.change.value);
  const arrow = insight.change.direction === 'down' ? '▼' : '▲';

  // Two rows for a prior → now comparison. Real absolute values when the
  // evidence carries them (live / captured); otherwise index prior to 100 and
  // derive `now` from the real % change, so demo still shows a before/after
  // rather than a lone progress bar.
  const nowRel = Math.max(100 + (insight.change.direction === 'up' ? abs : -abs), 0);
  const compareRows = hasComparison
    ? [
        { label: 'prior', bar: prov.prior as number, right: fmtNum(prov.prior as number) },
        { label: 'now', bar: prov.current as number, right: fmtNum(prov.current as number) },
      ]
    : [
        // absolute prior/now numbers aren't in this snapshot — show "--" for the
        // value but keep the row, so the comparison reads the same as live.
        { label: 'prior', bar: 100, right: '--' },
        { label: 'now', bar: nowRel, right: `${arrow} ${abs}%` },
      ];
  const barMax = Math.max(...compareRows.map((r) => r.bar), 1);

  return (
    <Link
      href={`/investigate/${insight.id}`}
      style={{ textDecoration: 'none', display: 'block' }}
    >
      <article
        className="bi-fade-up"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: '16px 20px',
        }}
      >
        {/* top row: badge + headline */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <SeverityBadge severity={insight.severity} />
          <span
            style={{
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.95rem',
              lineHeight: 1.3,
            }}
          >
            {insight.headline.toLowerCase()}
          </span>
        </div>

        {/* summary — the agent's one-line statement of what changed */}
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '0.875rem',
            lineHeight: 1.5,
            margin: '0 0 10px',
          }}
        >
          {insight.summary.toLowerCase()}
        </p>

        {/* the so-what: why this matters, and why it's scoped the way it is */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '0 0 12px' }}>
          {[
            // prefer the agent's business-impact sentence; fall back to the
            // derived explanation for demo / older snapshots that lack it.
            { label: 'why it matters', text: insight.impact?.trim() || whyItMatters(insight) },
            // forward-looking: what happens if the trend continues
            { label: 'outlook', text: insight.outlook?.trim() || forecastText(insight) },
            { label: 'scope', text: scopeExplain(insight) },
          ].map((d) => (
            <div key={d.label} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span
                style={{
                  flexShrink: 0,
                  width: 100,
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.62rem',
                  letterSpacing: '0.04em',
                  color: 'var(--text-tertiary)',
                  paddingTop: 1,
                }}
              >
                {d.label}
              </span>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.45 }}>
                {d.text}
              </span>
            </div>
          ))}
        </div>

        {/* meta row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          {insight.scope.map((tag) => (
            <span
              key={tag}
              title={
                tag.toLowerCase() === 'global'
                  ? 'measured across the whole workspace'
                  : `change localized to the ${tag.toLowerCase()} segment`
              }
              style={{
                background: 'var(--bg-elevated)',
                color: 'var(--text-tertiary)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '1px 6px',
                fontSize: '0.75rem',
                fontFamily: 'var(--font-mono), monospace',
              }}
            >
              {tag.toLowerCase()}
            </span>
          ))}

          <span
            style={{
              color: 'var(--text-tertiary)',
              fontSize: '0.75rem',
              fontFamily: 'var(--font-mono), monospace',
              marginLeft: 'auto',
            }}
          >
            {formatTimestamp(insight.timestamp)}
          </span>
        </div>

        {/* provenance: how this item came about — a prior → now comparison and
            the tool(s) used. Absolute values when the evidence carries them
            (live / captured); otherwise indexed from the real % change (demo). */}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <div
            className="lowercase"
            style={{
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.65rem',
              letterSpacing: '0.04em',
              color: 'var(--text-tertiary)',
              marginBottom: 8,
            }}
          >
            {insight.metric} · {arrow} {abs}% vs prior {humanizeBaseline(insight.change.baseline)}
            {!hasComparison && ' (relative)'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {compareRows.map((row) => (
              <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  className="lowercase"
                  style={{
                    width: 38,
                    flexShrink: 0,
                    fontFamily: 'var(--font-mono), monospace',
                    fontSize: '0.68rem',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  {row.label}
                </span>
                <div
                  style={{
                    flex: 1,
                    height: 10,
                    background: 'var(--bg-elevated)',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max((row.bar / barMax) * 100, 2)}%`,
                      height: '100%',
                      background: row.label === 'now' ? dirColor : 'var(--text-tertiary)',
                      borderRadius: 2,
                    }}
                  />
                </div>
                <span
                  style={{
                    width: 92,
                    flexShrink: 0,
                    textAlign: 'right',
                    fontFamily: 'var(--font-mono), monospace',
                    fontSize: '0.7rem',
                    color: row.label === 'now' ? dirColor : 'var(--text-secondary)',
                  }}
                >
                  {row.right}
                </span>
              </div>
            ))}
          </div>
          {/* always shown so the "gathered via" label is visible in both modes */}
          <div
            className="lowercase"
            style={{
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.68rem',
              color: 'var(--text-tertiary)',
            }}
          >
            via {prov.tools.length > 0 ? prov.tools.join(', ') : '--'}
          </div>
        </div>

        {/* investigate affordance */}
        <div
          style={{
            marginTop: 12,
            color: 'var(--text-tertiary)',
            fontSize: '0.8rem',
            fontFamily: 'var(--font-mono), monospace',
          }}
        >
          investigate →
        </div>
      </article>
    </Link>
  );
}
