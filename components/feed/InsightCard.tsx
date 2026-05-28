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
  const cmax = Math.max(prov.current ?? 0, prov.prior ?? 0, 1);
  const dirColor =
    insight.change.direction === 'down' ? 'var(--accent-coral)' : 'var(--accent-teal)';

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

        {/* provenance: how this item came about — current vs prior + tool(s) used */}
        {(hasComparison || prov.tools.length > 0) && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            {hasComparison && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  marginBottom: prov.tools.length ? 8 : 0,
                }}
              >
                {[
                  { label: 'prior', value: prov.prior as number, color: 'var(--text-tertiary)' },
                  { label: 'now', value: prov.current as number, color: dirColor },
                ].map((row) => (
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
                          width: `${Math.max((row.value / cmax) * 100, 2)}%`,
                          height: '100%',
                          background: row.color,
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
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {fmtNum(row.value)}
                    </span>
                  </div>
                ))}
              </div>
            )}
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
        )}

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
