'use client';

import ReasoningTrace, { type TraceItem } from '@/components/investigation/ReasoningTrace';

interface StatusLogProps {
  items: TraceItem[];
  /** header label, e.g. "how this briefing was gathered" / "how this was figured out" */
  title?: string;
  /** e.g. "3 queries" / "5 steps" — appended after the title */
  countLabel?: string;
  /** append "· running…" while work is in flight */
  scanning?: boolean;
  /** shown when there are no items yet (e.g. "connecting to the agent…") */
  emptyMessage?: string;
}

const muted: React.CSSProperties = {
  margin: 0,
  color: 'var(--text-tertiary)',
  fontFamily: 'var(--font-mono), monospace',
  fontSize: '0.72rem',
  lineHeight: 1.5,
};

/** Sticky sidebar that streams the agent's statuses/logs — reused on the feed
 *  and both investigation steps so "what's happening in the background" reads
 *  identically across the app. */
export default function StatusLog({
  items,
  title = 'statuses & logs',
  countLabel,
  scanning = false,
  emptyMessage = '—',
}: StatusLogProps) {
  return (
    <aside
      style={{
        position: 'sticky',
        top: 16,
        alignSelf: 'start',
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--bg-elevated)',
        maxHeight: 'calc(100vh - 96px)',
        overflowY: 'auto',
      }}
    >
      <div
        className="lowercase"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 1, // keep the header above the trace that scrolls under it
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-elevated)',
          fontFamily: 'var(--font-mono), monospace',
          fontSize: '0.72rem',
          color: 'var(--text-secondary)',
        }}
      >
        {title}
        {countLabel ? ` · ${countLabel}` : ''}
        {scanning ? ' · running…' : ''}
      </div>
      <div style={{ padding: '10px 16px 16px' }}>
        {items.length > 0 ? (
          <ReasoningTrace items={items} />
        ) : (
          <p className="lowercase" style={muted}>
            {emptyMessage}
          </p>
        )}
      </div>
    </aside>
  );
}
