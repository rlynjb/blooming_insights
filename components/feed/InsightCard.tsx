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

/** Compact USD like −$96.4k / $1.2m, using a true minus sign. */
function fmtUsd(n: number): string {
  const sign = n < 0 ? '−' : '';
  const v = Math.abs(n);
  const mag = v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}m` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}k` : `${Math.round(v)}`;
  return `${sign}$${mag}`;
}

/** Whole days since an ISO timestamp, or null if unparseable. */
function daysSince(ts: string): number | null {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}

const fmtPct = (v: number): string => `${v >= 0 ? '+' : ''}${v}%`;

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

  // ── business-owner enrichments (render only when the agent computed them) ──
  const days = daysSince(insight.timestamp);
  const dr = insight.downstreamReady;

  const tiles: { label: string; value: string; color?: string; sub?: string }[] = [];
  if (insight.revenueImpact) {
    tiles.push({
      label: 'revenue lost this window',
      value: fmtUsd(insight.revenueImpact.lostUsd),
      color: 'var(--accent-coral)',
      sub: `vs expected ${fmtUsd(insight.revenueImpact.expectedUsd)}`,
    });
  }
  if (insight.aov) {
    const { current, prior } = insight.aov;
    const delta = prior ? ((current - prior) / prior) * 100 : 0;
    tiles.push({
      label: 'aov',
      value: fmtUsd(current),
      sub: Math.abs(delta) < 2 ? 'stable vs prior' : `${delta < 0 ? 'down' : 'up'} ${Math.abs(Math.round(delta))}%`,
    });
  }
  if (insight.affectedCustomers != null) {
    tiles.push({ label: 'customers affected', value: `~${insight.affectedCustomers.toLocaleString()}` });
  }

  const funnel = insight.funnel;
  const funnelStages = funnel
    ? (['view', 'cart', 'checkout', 'purchase'] as const).map((k) => ({ k, v: funnel[k] }))
    : [];
  const leakKey = funnelStages.length
    ? funnelStages.reduce((a, b) => (b.v < a.v ? b : a)).k
    : null;

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
        {/* top row: badge + headline + time-since */}
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
          {days != null && (
            <span
              className="lowercase"
              style={{
                marginLeft: 'auto',
                flexShrink: 0,
                fontFamily: 'var(--font-mono), monospace',
                fontSize: '0.68rem',
                color: 'var(--text-tertiary)',
              }}
            >
              started ~{days} {days === 1 ? 'day' : 'days'} ago
            </span>
          )}
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

        {/* metric strip — revenue lost · aov · customers affected (when computed) */}
        {tiles.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))`,
              gap: 8,
              margin: '0 0 12px',
            }}
          >
            {tiles.map((t) => (
              <div key={t.label} style={{ background: 'var(--bg-elevated)', borderRadius: 4, padding: 12 }}>
                <div
                  className="lowercase"
                  style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)', marginBottom: 4, fontFamily: 'var(--font-mono), monospace' }}
                >
                  {t.label}
                </div>
                <div style={{ fontSize: '1.15rem', fontWeight: 500, color: t.color ?? 'var(--text-primary)' }}>
                  {t.value}
                </div>
                {t.sub && (
                  <div className="lowercase" style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {t.sub}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* funnel-leak chip — view / cart / checkout / purchase % deltas */}
        {funnel && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, margin: '0 0 12px' }}>
            <div
              className="lowercase"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: '0.62rem',
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono), monospace',
                marginBottom: 8,
              }}
            >
              <span>funnel · this window vs prior</span>
              {leakKey && <span style={{ color: 'var(--accent-coral)' }}>▼ leak at {leakKey}</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }}>
              {funnelStages.map((s) => {
                const isLeak = s.k === leakKey;
                return (
                  <div
                    key={s.k}
                    style={{
                      background: isLeak ? 'rgba(251,113,133,0.12)' : 'var(--bg-elevated)',
                      border: isLeak ? '1px solid var(--accent-coral)' : '1px solid transparent',
                      borderRadius: 4,
                      padding: '8px 10px',
                    }}
                  >
                    <div className="lowercase" style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)' }}>{s.k}</div>
                    <div
                      style={{
                        fontSize: '0.82rem',
                        fontWeight: 500,
                        fontFamily: 'var(--font-mono), monospace',
                        color: isLeak ? 'var(--accent-coral)' : s.v < 0 ? 'var(--accent-coral)' : 'var(--text-primary)',
                      }}
                    >
                      {fmtPct(s.v)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* the so-what: why this matters, and why it's scoped the way it is */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '0 0 12px' }}>
          {[
            // prefer the agent's business-impact sentence; fall back to the
            // derived explanation for demo / older snapshots that lack it.
            { label: 'why it matters', text: insight.impact?.trim() || whyItMatters(insight) },
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

        {/* investigate affordance + downstream-ready status */}
        <div
          style={{
            marginTop: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: 'var(--text-tertiary)',
            fontSize: '0.8rem',
            fontFamily: 'var(--font-mono), monospace',
          }}
        >
          <span>investigate →</span>
          {dr && (dr.diagnosis || dr.recommendations > 0) && (
            <span className="lowercase" style={{ marginLeft: 'auto', fontSize: '0.68rem', color: 'var(--accent-teal)' }}>
              ✓ diagnosis ready · {dr.recommendations} {dr.recommendations === 1 ? 'action' : 'actions'} proposed
            </span>
          )}
        </div>
      </article>
    </Link>
  );
}
