'use client';

import { useState } from 'react';
import type { Diagnosis } from '@/lib/mcp/types';
import Skeleton from '@/components/shared/Skeleton';

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

export default function EvidencePanel({ diagnosis, loading }: EvidencePanelProps) {
  const [hypothesesOpen, setHypothesesOpen] = useState(false);

  if (!diagnosis) {
    if (loading) {
      return (
        <div style={cardStyle}>
          <p
            className="text-sm lowercase"
            style={{
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono), monospace',
              margin: '0 0 12px',
            }}
          >
            diagnosing…
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Skeleton height={16} />
            <Skeleton height={16} width="80%" />
            <Skeleton height={16} width="60%" />
          </div>
        </div>
      );
    }
    return (
      <div style={cardStyle}>
        <p
          className="text-sm lowercase"
          style={{ color: 'var(--text-tertiary)', margin: 0 }}
        >
          no diagnosis yet
        </p>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <h2
        className="lowercase"
        style={{
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono), monospace',
          fontSize: '0.7rem',
          letterSpacing: '0.06em',
          margin: '0 0 10px',
        }}
      >
        diagnosis
      </h2>

      {/* conclusion — model prose, render as-is */}
      <p
        style={{
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-display), system-ui, sans-serif',
          fontSize: '1rem',
          lineHeight: 1.45,
          margin: '0 0 16px',
        }}
      >
        {diagnosis.conclusion}
      </p>

      {/* affected customers */}
      {diagnosis.affectedCustomers && (
        <div
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '8px 12px',
            marginBottom: 16,
          }}
        >
          <div
            style={{
              color: 'var(--accent-coral)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.95rem',
            }}
          >
            {diagnosis.affectedCustomers.count.toLocaleString()}
          </div>
          <div
            style={{
              color: 'var(--text-secondary)',
              fontSize: '0.8rem',
              lineHeight: 1.4,
            }}
          >
            {diagnosis.affectedCustomers.segmentDescription}
          </div>
        </div>
      )}

      {/* evidence */}
      {diagnosis.evidence.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3
            className="lowercase"
            style={{
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.7rem',
              letterSpacing: '0.06em',
              margin: '0 0 8px',
            }}
          >
            evidence
          </h3>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {diagnosis.evidence.map((e, i) => (
              <li
                key={i}
                style={{
                  display: 'flex',
                  gap: 8,
                  color: 'var(--text-secondary)',
                  fontSize: '0.8rem',
                  lineHeight: 1.5,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    color: 'var(--accent-teal)',
                    fontFamily: 'var(--font-mono), monospace',
                    flexShrink: 0,
                  }}
                >
                  ·
                </span>
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* hypotheses considered — collapsible */}
      {diagnosis.hypothesesConsidered.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setHypothesesOpen((v) => !v)}
            aria-expanded={hypothesesOpen}
            className="lowercase"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              padding: 0,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.7rem',
              letterSpacing: '0.06em',
              textAlign: 'left',
            }}
          >
            <span aria-hidden style={{ display: 'inline-block', width: 10 }}>
              {hypothesesOpen ? '▾' : '▸'}
            </span>
            hypotheses considered ({diagnosis.hypothesesConsidered.length})
          </button>

          {hypothesesOpen && (
            <ul
              style={{
                listStyle: 'none',
                margin: '10px 0 0',
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              {diagnosis.hypothesesConsidered.map((h, i) => (
                <li key={i} style={{ display: 'flex', gap: 8 }}>
                  <span
                    aria-label={h.supported ? 'supported' : 'ruled out'}
                    title={h.supported ? 'supported' : 'ruled out'}
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      marginTop: 5,
                      background: h.supported
                        ? 'var(--accent-teal)'
                        : 'var(--text-tertiary)',
                      flexShrink: 0,
                    }}
                  />
                  <div>
                    <div
                      style={{
                        color: 'var(--text-primary)',
                        fontSize: '0.8rem',
                        lineHeight: 1.45,
                      }}
                    >
                      {h.hypothesis}
                    </div>
                    <div
                      style={{
                        color: 'var(--text-tertiary)',
                        fontSize: '0.75rem',
                        lineHeight: 1.45,
                        marginTop: 2,
                      }}
                    >
                      {h.reasoning}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
