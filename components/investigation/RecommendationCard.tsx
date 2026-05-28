'use client';

import type { Recommendation } from '@/lib/mcp/types';

interface RecommendationCardProps {
  recommendation: Recommendation;
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

export default function RecommendationCard({ recommendation }: RecommendationCardProps) {
  const { title, rationale, bloomreachFeature, steps, estimatedImpact, confidence } =
    recommendation;
  const cColor = confidenceColor(confidence);

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '16px 20px',
      }}
    >
      {/* top row: feature chip + confidence indicator */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 10,
        }}
      >
        <span
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.72rem',
            padding: '2px 8px',
          }}
        >
          {bloomreachFeature}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            marginLeft: 'auto',
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: cColor,
              flexShrink: 0,
            }}
          />
          <span
            className="lowercase"
            style={{
              color: cColor,
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.72rem',
            }}
          >
            {confidence}
          </span>
        </span>
      </div>

      {/* title — model prose, render as-is */}
      <p
        style={{
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-display), system-ui, sans-serif',
          fontSize: '0.95rem',
          fontWeight: 600,
          lineHeight: 1.4,
          margin: '0 0 8px',
        }}
      >
        {title}
      </p>

      {/* rationale */}
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: '0.8rem',
          lineHeight: 1.5,
          margin: '0 0 12px',
        }}
      >
        {rationale}
      </p>

      {/* steps */}
      {steps.length > 0 && (
        <ol
          style={{
            listStyle: 'decimal',
            margin: '0 0 12px',
            padding: '0 0 0 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {steps.map((s, i) => (
            <li
              key={i}
              style={{
                color: 'var(--text-secondary)',
                fontSize: '0.78rem',
                lineHeight: 1.45,
              }}
            >
              {s}
            </li>
          ))}
        </ol>
      )}

      {/* footer: estimated impact */}
      <p
        className="lowercase"
        style={{
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono), monospace',
          fontSize: '0.72rem',
          lineHeight: 1.4,
          margin: 0,
        }}
      >
        impact: <span style={{ textTransform: 'none' }}>{estimatedImpact}</span>
      </p>
    </div>
  );
}
