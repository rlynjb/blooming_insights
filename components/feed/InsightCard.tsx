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

export default function InsightCard({ insight }: InsightCardProps) {
  return (
    <Link
      href={`/investigate/${insight.id}`}
      style={{ textDecoration: 'none', display: 'block' }}
    >
      <article
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
