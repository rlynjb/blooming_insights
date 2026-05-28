import type { Severity } from '@/lib/mcp/types';

const severityColor: Record<Severity, string> = {
  critical: 'var(--accent-coral)',
  warning: 'var(--accent-amber)',
  positive: 'var(--accent-teal)',
  info: 'var(--text-tertiary)',
};

interface SeverityBadgeProps {
  severity: Severity;
}

export default function SeverityBadge({ severity }: SeverityBadgeProps) {
  return (
    <span
      aria-label={severity}
      title={severity}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: severityColor[severity],
        flexShrink: 0,
      }}
    />
  );
}
