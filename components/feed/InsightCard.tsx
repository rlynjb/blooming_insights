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
        { label: 'prior', bar: 100, right: '' },
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

        {/* summary */}
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '0.875rem',
            lineHeight: 1.5,
            margin: '0 0 12px',
          }}
        >
          {insight.summary.toLowerCase()}
        </p>

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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: prov.tools.length ? 8 : 0 }}>
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
          {prov.tools.length > 0 && (
            <div
              className="lowercase"
              style={{
                fontFamily: 'var(--font-mono), monospace',
                fontSize: '0.68rem',
                color: 'var(--text-tertiary)',
              }}
            >
              via {prov.tools.join(', ')}
            </div>
          )}
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
