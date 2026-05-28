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
    }
  | {
      kind: 'tool';
      id: string;
      toolName: string;
      status: 'running' | 'done';
      durationMs?: number;
      result?: unknown;
      error?: string;
    };

const stepKindColor: Record<'thought' | 'hypothesis' | 'conclusion', string> = {
  thought: 'var(--text-tertiary)',
  hypothesis: 'var(--accent-amber)',
  conclusion: 'var(--accent-teal)',
};

interface ReasoningTraceProps {
  items: TraceItem[];
}

export default function ReasoningTrace({ items }: ReasoningTraceProps) {
  return (
    <div
      style={{
        position: 'relative',
        paddingLeft: 20,
        borderLeft: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
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
                marginBottom: 6,
                flexWrap: 'wrap',
              }}
            >
              <AgentBadge agent={item.agent} />
              <span
                style={{
                  color: stepKindColor[item.stepKind],
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.7rem',
                  letterSpacing: '0.04em',
                }}
              >
                {item.stepKind}
              </span>
            </div>
            <p
              style={{
                color: 'var(--text-secondary)',
                fontSize: '0.875rem',
                lineHeight: 1.55,
                margin: 0,
                whiteSpace: 'pre-wrap',
              }}
            >
              {item.content}
            </p>
          </div>
        ) : (
          <div key={item.id} className="bi-fade-up">
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
