'use client';

import type { Diagnosis } from '@/lib/mcp/types';
import Skeleton from '@/components/shared/Skeleton';
import { diagnosisConfidence, hypothesesTested } from '@/lib/insights/derive';

interface EvidencePanelProps {
  diagnosis: Diagnosis | null;
  loading: boolean;
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '16px 20px',
};

const tileStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  borderRadius: 4,
  padding: '12px',
};

const tileLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.62rem',
  letterSpacing: '0.04em',
  color: 'var(--text-tertiary)',
  marginBottom: 4,
};

const confColor: Record<'high' | 'medium' | 'low', string> = {
  high: 'var(--accent-teal)',
  medium: 'var(--accent-amber)',
  low: 'var(--accent-coral)',
};

const sectionLabel: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.7rem',
  letterSpacing: '0.06em',
  margin: '0 0 8px',
};

export default function EvidencePanel({ diagnosis, loading }: EvidencePanelProps) {
  if (!diagnosis) {
    return (
      <div style={cardStyle}>
        <p
          className="text-sm lowercase"
          style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono), monospace', margin: loading ? '0 0 12px' : 0 }}
        >
          {loading ? 'diagnosing…' : 'no diagnosis yet'}
        </p>
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Skeleton height={16} />
            <Skeleton height={16} width="80%" />
            <Skeleton height={16} width="60%" />
          </div>
        )}
      </div>
    );
  }

  const confidence = diagnosisConfidence(diagnosis);
  const { tested, total } = hypothesesTested(diagnosis);
  const affected = diagnosis.affectedCustomers;

  return (
    <div className="bi-fade-up" style={cardStyle}>
      {/* tiles: confidence · customers affected */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: affected ? '1fr 1fr' : '1fr',
          gap: 8,
          marginBottom: 16,
        }}
      >
        <div style={tileStyle}>
          <div className="lowercase" style={tileLabel}>
            confidence
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span className="lowercase" style={{ fontSize: '1.1rem', fontWeight: 500, color: confColor[confidence] }}>
              {confidence}
            </span>
            {total > 0 && (
              <span className="lowercase" style={{ fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>
                {tested} of {total} hypotheses tested
              </span>
            )}
          </div>
        </div>
        {affected && (
          <div style={tileStyle}>
            <div className="lowercase" style={tileLabel}>
              customers affected
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '1.1rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                ~{affected.count.toLocaleString()}
              </span>
              <span className="lowercase" style={{ fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>
                {affected.segmentDescription}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* conclusion callout */}
      <div
        style={{
          background: 'var(--bg-elevated)',
          borderLeft: '2px solid var(--accent-amber)',
          borderRadius: 4,
          padding: '12px 14px',
          marginBottom: 18,
        }}
      >
        <div
          className="lowercase"
          style={{
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.62rem',
            letterSpacing: '0.06em',
            color: 'var(--accent-amber)',
            marginBottom: 4,
          }}
        >
          conclusion
        </div>
        <p
          style={{
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-display), system-ui, sans-serif',
            fontSize: '0.95rem',
            lineHeight: 1.45,
            margin: 0,
          }}
        >
          {diagnosis.conclusion}
        </p>
      </div>

      {/* hypotheses — always-visible chips; click a row for the reasoning */}
      {diagnosis.hypothesesConsidered.length > 0 && (
        <div style={{ marginBottom: diagnosis.evidence.length > 0 ? 18 : 0 }}>
          <h3 className="lowercase" style={sectionLabel}>
            hypotheses tested
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {diagnosis.hypothesesConsidered.map((h, i) => (
              <details
                key={i}
                style={{ background: 'var(--bg-elevated)', borderRadius: 4, padding: '8px 12px' }}
              >
                <summary
                  className="lowercase"
                  style={{
                    listStyle: 'none',
                    cursor: h.reasoning?.trim() ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <span
                    className="lowercase"
                    style={{
                      flexShrink: 0,
                      fontFamily: 'var(--font-mono), monospace',
                      fontSize: '0.62rem',
                      padding: '2px 8px',
                      borderRadius: 999,
                      fontWeight: 500,
                      background: h.supported ? 'rgba(0,217,163,0.15)' : 'var(--bg-surface)',
                      color: h.supported ? 'var(--accent-teal)' : 'var(--text-tertiary)',
                      border: `1px solid ${h.supported ? 'var(--accent-teal)' : 'var(--border)'}`,
                    }}
                  >
                    {h.supported ? 'supported' : 'ruled out'}
                  </span>
                  <span style={{ fontSize: '0.82rem', color: h.supported ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                    {h.hypothesis}
                  </span>
                </summary>
                {h.reasoning?.trim() && (
                  <p
                    style={{
                      margin: '8px 0 0',
                      fontSize: '0.78rem',
                      lineHeight: 1.5,
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    {h.reasoning}
                  </p>
                )}
              </details>
            ))}
          </div>
        </div>
      )}

      {/* key evidence */}
      {diagnosis.evidence.length > 0 && (
        <div>
          <h3 className="lowercase" style={sectionLabel}>
            key evidence
          </h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {diagnosis.evidence.map((e, i) => (
              <li
                key={i}
                style={{ display: 'flex', gap: 8, color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5 }}
              >
                <span aria-hidden style={{ color: 'var(--accent-teal)', fontFamily: 'var(--font-mono), monospace', flexShrink: 0 }}>
                  ·
                </span>
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
