'use client';

import type { Recommendation } from '@/lib/mcp/types';
import { impactRange, impactAssumption } from '@/lib/insights/derive';

interface RecommendationCardProps {
  recommendation: Recommendation;
  index?: number; // 0-based position in the sorted array (for "action N of M")
  total?: number;
}

function confidenceColor(confidence: Recommendation['confidence']): string {
  switch (confidence) {
    case 'high':
      return 'var(--accent-teal)';
    case 'medium':
      return 'var(--accent-amber)';
    case 'low':
    default:
      return 'var(--text-tertiary)';
  }
}

// Bloomreach app section per feature (best-effort deep link; opens in a new tab).
const FEATURE_PATH: Record<Recommendation['bloomreachFeature'], string> = {
  scenario: 'scenarios',
  segment: 'segmentations',
  campaign: 'campaigns',
  voucher: 'vouchers',
  experiment: 'experiments',
};

const tile: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  borderRadius: 4,
  padding: '10px 12px',
};
const tileLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.62rem',
  color: 'var(--text-tertiary)',
  marginBottom: 4,
  letterSpacing: '0.03em',
};
const tileValue: React.CSSProperties = { fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-primary)' };
const sectionLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.62rem',
  letterSpacing: '0.06em',
  color: 'var(--text-tertiary)',
  margin: '0 0 8px',
};

export default function RecommendationCard({ recommendation, index, total }: RecommendationCardProps) {
  const {
    title,
    rationale,
    bloomreachFeature,
    steps,
    estimatedImpact,
    confidence,
    effort,
    timeToSetUpMinutes,
    readResultInDays,
    prerequisites,
    successMetric,
  } = recommendation;
  const cColor = confidenceColor(confidence);
  const range = impactRange(estimatedImpact);
  const assumption = impactAssumption(estimatedImpact);
  const isHighest = index === 0;
  const hasTiles = effort || timeToSetUpMinutes != null || readResultInDays != null;

  return (
    <div
      className="bi-fade-up"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '16px 20px' }}
    >
      {/* top row: feature chip + position/highest + confidence */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span
          className="lowercase"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 999,
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.68rem',
            padding: '2px 10px',
          }}
        >
          {bloomreachFeature}
        </span>
        {index != null && total != null && (
          <span className="lowercase" style={{ fontFamily: 'var(--font-mono), monospace', fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>
            action {index + 1} of {total}
            {isHighest && <span style={{ color: 'var(--accent-teal)' }}> · highest impact</span>}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: cColor, flexShrink: 0 }} />
          <span className="lowercase" style={{ fontFamily: 'var(--font-mono), monospace', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
            {confidence} confidence
          </span>
        </span>
      </div>

      {/* title */}
      <p
        style={{
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-display), system-ui, sans-serif',
          fontSize: '0.95rem',
          fontWeight: 600,
          lineHeight: 1.4,
          margin: '0 0 6px',
        }}
      >
        {title}
      </p>

      {/* rationale */}
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, margin: '0 0 16px' }}>
        {rationale}
      </p>

      {/* expected impact — highlighted, with the assumption that produced it */}
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--accent-teal)',
          borderRadius: 4,
          padding: '10px 12px',
          marginBottom: hasTiles || prerequisites?.length || steps.length || successMetric ? 16 : 4,
        }}
      >
        <div
          className="lowercase"
          style={{ fontFamily: 'var(--font-mono), monospace', fontSize: '0.6rem', letterSpacing: '0.08em', color: 'var(--accent-teal)', marginBottom: 3 }}
        >
          expected impact
        </div>
        <p style={{ color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: 500, lineHeight: 1.4, margin: 0 }}>
          {range}
        </p>
        {assumption && (
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.72rem', lineHeight: 1.45, margin: '4px 0 0' }}>
            {assumption}
          </p>
        )}
      </div>

      {/* effort · time to set up · read result in */}
      {hasTiles && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginBottom: 16 }}>
          <div style={tile}>
            <div className="lowercase" style={tileLabel}>effort</div>
            <div className="lowercase" style={tileValue}>{effort ?? '—'}</div>
          </div>
          <div style={tile}>
            <div className="lowercase" style={tileLabel}>time to set up</div>
            <div style={tileValue}>{timeToSetUpMinutes != null ? `~${timeToSetUpMinutes} min` : '—'}</div>
          </div>
          <div style={tile}>
            <div className="lowercase" style={tileLabel}>read result in</div>
            <div style={tileValue}>{readResultInDays != null ? `${readResultInDays} ${readResultInDays === 1 ? 'day' : 'days'}` : '—'}</div>
          </div>
        </div>
      )}

      {/* prerequisites */}
      {prerequisites && prerequisites.length > 0 && (
        <div style={{ ...tile, marginBottom: 16 }}>
          <div className="lowercase" style={{ ...tileLabel, marginBottom: 6 }}>prerequisites</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
            {prerequisites.map((p, i) => (
              <span key={i} className="lowercase" style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                <span
                  aria-hidden
                  style={{
                    color: p.satisfied ? 'var(--accent-teal)' : 'var(--accent-amber)',
                    marginRight: 4,
                    fontFamily: 'var(--font-mono), monospace',
                  }}
                >
                  {p.satisfied ? '✓' : '○'}
                </span>
                {p.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* setup steps */}
      {steps.length > 0 && (
        <div style={{ marginBottom: successMetric ? 16 : 14 }}>
          <div className="lowercase" style={sectionLabel}>setup steps</div>
          <ol style={{ margin: 0, padding: '0 0 0 18px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {steps.map((s, i) => (
              <li key={i} style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.45 }}>
                {s}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* success metric */}
      {successMetric && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginBottom: 14 }}>
          <div className="lowercase" style={sectionLabel}>success metric</div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.5, margin: 0 }}>{successMetric}</p>
        </div>
      )}

      {/* footer: open in bloomreach */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <a
          href={`https://app.bloomreach.com/${FEATURE_PATH[bloomreachFeature]}`}
          target="_blank"
          rel="noopener noreferrer"
          className="lowercase"
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 4,
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.75rem',
            padding: '4px 12px',
            textDecoration: 'none',
          }}
        >
          open in bloomreach ↗
        </a>
      </div>
    </div>
  );
}
