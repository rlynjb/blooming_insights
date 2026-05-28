import type { CSSProperties } from 'react';

// The three-stage process blooming insights runs. Only `monitoring` executes on
// the feed (via /api/briefing); `diagnostic` and `recommendation` run when an
// insight is opened (app/investigate/[id]). The stepper is honest about that —
// it shows monitoring's REAL live status while the briefing streams, and frames
// the other two as the phases that activate on investigate.

type FeedStatus = 'loading' | 'error' | 'empty' | 'loaded';
type StepState = 'active' | 'complete' | 'pending' | 'error';

interface FeedStepperProps {
  status: FeedStatus;
  /** Live monitoring status (the actual query the agent is running). */
  statusText?: string;
  /** Number of monitoring tool calls made so far (live). */
  queryCount?: number;
  /** Insights found, once monitoring completes. */
  insightCount?: number;
}

const STEPS = [
  { key: 'monitoring', label: 'monitoring anomalies' },
  { key: 'diagnostic', label: 'investigating the issue' },
  { key: 'recommendation', label: 'decision & recommendation' },
] as const;

function monitoringState(status: FeedStatus): StepState {
  if (status === 'loading') return 'active';
  if (status === 'error') return 'error';
  return 'complete'; // loaded | empty
}

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

function monitoringSub(p: FeedStepperProps): string {
  switch (p.status) {
    case 'loading': {
      const q = p.statusText?.trim();
      const n = p.queryCount ?? 0;
      if (q) return n > 0 ? `query ${n} · ${q}` : q;
      return 'scanning your workspace…';
    }
    case 'empty':
      return 'no notable changes';
    case 'error':
      return 'scan failed';
    case 'loaded':
    default: {
      const c = p.insightCount ?? 0;
      return `${c} change${c === 1 ? '' : 's'} found`;
    }
  }
}

export default function FeedStepper(props: FeedStepperProps) {
  const subFor = (i: number): string =>
    i === 0 ? monitoringSub(props) : 'opens when you investigate';

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
        const state: StepState = i === 0 ? monitoringState(props.status) : 'pending';
        const labelColor =
          state === 'pending'
            ? 'var(--text-tertiary)'
            : state === 'error'
              ? 'var(--accent-coral)'
              : 'var(--text-primary)';
        const subColor = state === 'active' ? 'var(--text-secondary)' : 'var(--text-tertiary)';
        return (
          <div
            key={step.key}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '12px 14px',
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              borderLeft: i > 0 ? '1px solid var(--border)' : undefined,
            }}
          >
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
              <div className="lowercase" style={{ ...subStyle, color: subColor }} title={subFor(i)}>
                {subFor(i)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
