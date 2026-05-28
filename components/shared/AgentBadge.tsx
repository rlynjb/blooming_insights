import type { AgentName } from '@/lib/mcp/types';

const agentColor: Record<AgentName, string> = {
  diagnostic: 'var(--accent-purple)',
  monitoring: 'var(--accent-teal)',
  recommendation: 'var(--accent-amber)',
  coordinator: 'var(--text-secondary)',
};

interface AgentBadgeProps {
  agent: AgentName;
}

export default function AgentBadge({ agent }: AgentBadgeProps) {
  const color = agentColor[agent];
  return (
    <span
      style={{
        display: 'inline-block',
        background: 'var(--bg-elevated)',
        color,
        border: `1px solid ${color}`,
        borderRadius: 4,
        padding: '1px 6px',
        fontSize: '0.7rem',
        lineHeight: 1.4,
        fontFamily: 'var(--font-mono), monospace',
        whiteSpace: 'nowrap',
      }}
    >
      {agent}
    </span>
  );
}
