import type { CSSProperties } from 'react';

type Stage = 'monitoring' | 'diagnostic' | 'recommendation';
type StageState = 'complete' | 'active' | 'pending';

interface AgentPipelineProps {
  active: Stage | null;
  done?: boolean;
}

const STAGES: Stage[] = ['monitoring', 'diagnostic', 'recommendation'];

// accent color used for the active dot, by stage
const activeColor: Record<Stage, string> = {
  monitoring: 'var(--accent-teal)',
  diagnostic: 'var(--accent-purple)',
  recommendation: 'var(--accent-amber)',
};

function stateFor(stage: Stage, active: Stage | null, done: boolean): StageState {
  if (done) return 'complete';
  if (active === null) return 'pending';
  const stageIdx = STAGES.indexOf(stage);
  const activeIdx = STAGES.indexOf(active);
  if (stageIdx < activeIdx) return 'complete';
  if (stageIdx === activeIdx) return 'active';
  return 'pending';
}

const labelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.7rem',
  letterSpacing: '0.02em',
};

export default function AgentPipeline({ active, done = false }: AgentPipelineProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '4px 10px',
      }}
    >
      {STAGES.map((stage, i) => {
        const state = stateFor(stage, active, done);
        const dotColor =
          state === 'complete'
            ? 'var(--accent-teal)'
            : state === 'active'
              ? activeColor[stage]
              : 'var(--text-tertiary)';
        const textColor =
          state === 'complete'
            ? 'var(--text-secondary)'
            : state === 'active'
              ? 'var(--text-primary)'
              : 'var(--text-tertiary)';

        return (
          <span key={stage} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span
                aria-hidden
                className={state === 'active' ? 'animate-pulse' : undefined}
                style={{
                  display: 'inline-block',
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: dotColor,
                  flexShrink: 0,
                }}
              />
              <span className="lowercase" style={{ ...labelStyle, color: textColor }}>
                {stage}
              </span>
            </span>
            {i < STAGES.length - 1 && (
              <span aria-hidden style={{ ...labelStyle, color: 'var(--text-tertiary)' }}>
                →
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
