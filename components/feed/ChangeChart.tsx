import type { Insight } from '@/lib/mcp/types';

// A compact comparison chart of the briefing's anomalies: one bar per metric,
// width ∝ |% change| (normalized to the largest), colored by severity, with the
// direction arrow + signed percentage. Gives an at-a-glance ranking of what moved.

const sevColor: Record<string, string> = {
  critical: 'var(--accent-coral)',
  warning: 'var(--accent-amber)',
  positive: 'var(--accent-teal)',
  info: 'var(--text-tertiary)',
};

export default function ChangeChart({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) return null;
  const max = Math.max(...insights.map((i) => Math.abs(i.change.value)), 1);

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--bg-elevated)',
        padding: '14px 16px',
        marginBottom: 20,
      }}
    >
      <div
        className="lowercase"
        style={{
          fontFamily: 'var(--font-mono), monospace',
          fontSize: '0.7rem',
          color: 'var(--text-tertiary)',
          letterSpacing: '0.06em',
          marginBottom: 12,
        }}
      >
        what changed · % vs prior {insights[0].change.baseline}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {insights.map((i) => {
          const pct = Math.abs(i.change.value);
          const width = Math.max((pct / max) * 100, 3);
          const color = sevColor[i.severity] ?? 'var(--text-tertiary)';
          const arrow = i.change.direction === 'down' ? '▼' : '▲';
          return (
            <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                className="lowercase"
                title={i.metric}
                style={{
                  width: 130,
                  flexShrink: 0,
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.72rem',
                  color: 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {i.metric}
              </span>
              <div
                style={{
                  flex: 1,
                  height: 14,
                  background: 'var(--bg-surface)',
                  borderRadius: 3,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${width}%`,
                    height: '100%',
                    background: color,
                    borderRadius: 3,
                    transition: 'width 0.4s ease',
                  }}
                />
              </div>
              <span
                className="lowercase"
                style={{
                  width: 78,
                  flexShrink: 0,
                  textAlign: 'right',
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.72rem',
                  color,
                }}
              >
                {arrow} {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
