import type { AgentName } from '@/lib/mcp/types';
import AgentBadge from '@/components/shared/AgentBadge';
import ToolCallBlock from './ToolCallBlock';

export type TraceItem =
  | {
      kind: 'step';
      id: string;
      agent: AgentName;
      stepKind: 'thought' | 'hypothesis' | 'conclusion';
      content: string;
      ts?: number; // when this line was recorded (epoch ms), shown as a log timestamp
    }
  | {
      kind: 'tool';
      id: string;
      toolName: string;
      status: 'running' | 'done';
      durationMs?: number;
      result?: unknown;
      error?: string;
      ts?: number;
    };

const stepKindColor: Record<'thought' | 'hypothesis' | 'conclusion', string> = {
  thought: 'var(--text-tertiary)',
  hypothesis: 'var(--accent-amber)',
  conclusion: 'var(--accent-teal)',
};

const tsStyle = {
  color: 'var(--text-tertiary)',
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.6rem',
  opacity: 0.65,
} as const;

function fmtTs(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour12: false });
  } catch {
    return '';
  }
}

interface ReasoningTraceProps {
  items: TraceItem[];
}

export default function ReasoningTrace({ items }: ReasoningTraceProps) {
  return (
    <div
      style={{
        position: 'relative',
        paddingLeft: 16,
        borderLeft: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {items.map((item) =>
        item.kind === 'step' ? (
          <div key={item.id} className="bi-fade-up">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 4,
                flexWrap: 'wrap',
              }}
            >
              <AgentBadge agent={item.agent} />
              <span
                style={{
                  color: stepKindColor[item.stepKind],
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.62rem',
                  letterSpacing: '0.04em',
                }}
              >
                {item.stepKind}
              </span>
              {item.ts && (
                <span style={{ ...tsStyle, marginLeft: 'auto' }}>{fmtTs(item.ts)}</span>
              )}
            </div>
            <p
              style={{
                color: 'var(--text-secondary)',
                fontSize: '0.75rem',
                lineHeight: 1.5,
                margin: 0,
                whiteSpace: 'pre-wrap',
              }}
            >
              {item.content}
            </p>
          </div>
        ) : (
          <div key={item.id} className="bi-fade-up">
            {item.ts && <div style={{ ...tsStyle, marginBottom: 3 }}>{fmtTs(item.ts)}</div>}
            <ToolCallBlock
              toolName={item.toolName}
              status={item.status}
              durationMs={item.durationMs}
              result={item.result}
              error={item.error}
            />
          </div>
        ),
      )}
    </div>
  );
}
