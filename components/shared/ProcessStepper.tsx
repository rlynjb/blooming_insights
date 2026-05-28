import type { CSSProperties } from 'react';
import Link from 'next/link';

export type StepState = 'pending' | 'active' | 'complete' | 'error';

export interface StepInput {
  state: StepState;
  /** short status line under the label */
  sub?: string;
  /** when set, the step becomes a link (used to jump between investigation steps) */
  href?: string;
}

interface ProcessStepperProps {
  monitoring: StepInput;
  diagnostic: StepInput;
  recommendation: StepInput;
}

// The three stages blooming insights runs, with fixed wording shared across the
// feed and the investigation view so the process reads identically on both.
// Each page drives the per-step state + status: on the feed, monitoring is the
// live one; on an investigation, monitoring is already complete and the other
// two run live.
const STEPS = [
  { key: 'monitoring', label: 'monitoring anomalies' },
  { key: 'diagnostic', label: 'investigating the issue' },
  { key: 'recommendation', label: 'decision & recommendation' },
] as const;

const labelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.78rem',
  letterSpacing: '0.01em',
};

const subStyle: CSSProperties = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.68rem',
  marginTop: 3,
  lineHeight: 1.35,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function badgeStyle(state: StepState): CSSProperties {
  const base: CSSProperties = {
    width: 22,
    height: 22,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.7rem',
    fontFamily: 'var(--font-mono), monospace',
    flexShrink: 0,
  };
  if (state === 'complete' || state === 'active')
    return { ...base, background: 'var(--accent-teal)', color: 'var(--bg-base)' };
  if (state === 'error')
    return { ...base, background: 'var(--accent-coral)', color: 'var(--bg-base)' };
  return { ...base, border: '1px solid var(--border)', color: 'var(--text-tertiary)' };
}

export default function ProcessStepper({
  monitoring,
  diagnostic,
  recommendation,
}: ProcessStepperProps) {
  const inputs: StepInput[] = [monitoring, diagnostic, recommendation];
  return (
    <div
      role="group"
      aria-label="analysis pipeline"
      style={{
        display: 'flex',
        marginBottom: 32,
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--bg-elevated)',
        overflow: 'hidden',
      }}
    >
      {STEPS.map((step, i) => {
        const { state, sub, href } = inputs[i];
        const labelColor =
          state === 'pending'
            ? 'var(--text-tertiary)'
            : state === 'error'
              ? 'var(--accent-coral)'
              : 'var(--text-primary)';
        const subColor = state === 'active' ? 'var(--text-secondary)' : 'var(--text-tertiary)';
        const wrapStyle: CSSProperties = {
          flex: 1,
          minWidth: 0,
          padding: '12px 14px',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          borderLeft: i > 0 ? '1px solid var(--border)' : undefined,
          textDecoration: 'none',
          cursor: href ? 'pointer' : 'default',
        };
        const inner = (
          <>
            <span
              aria-hidden
              className={state === 'active' ? 'animate-pulse' : undefined}
              style={badgeStyle(state)}
            >
              {state === 'complete' ? '✓' : state === 'error' ? '!' : i + 1}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="lowercase" style={{ ...labelStyle, color: labelColor }}>
                {step.label}
              </div>
              {sub && (
                <div className="lowercase" style={{ ...subStyle, color: subColor }} title={sub}>
                  {sub}
                </div>
              )}
            </div>
          </>
        );
        return href ? (
          <Link key={step.key} href={href} style={wrapStyle}>
            {inner}
          </Link>
        ) : (
          <div key={step.key} style={wrapStyle}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
