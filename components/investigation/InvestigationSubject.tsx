'use client';

import { useEffect, useState } from 'react';
import type { Insight } from '@/lib/mcp/types';
import SeverityBadge from '@/components/feed/SeverityBadge';

/** Shows which feed item is being investigated. Reads the insight the feed
 *  stashed in sessionStorage (`bi:insight:<id>`, written in both demo and live)
 *  when the card was clicked. Renders nothing if it isn't available (e.g. a
 *  direct deep-link), where the stepper + diagnosis still convey the subject. */
export default function InvestigationSubject({ id }: { id?: string }) {
  const [insight, setInsight] = useState<Insight | null>(null);

  useEffect(() => {
    if (!id) return;
    try {
      const raw = sessionStorage.getItem(`bi:insight:${id}`);
      if (raw) setInsight(JSON.parse(raw) as Insight);
    } catch {
      /* sessionStorage blocked — render nothing */
    }
  }, [id]);

  if (!insight) return null;

  return (
    <div
      style={{
        marginBottom: 24,
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--bg-surface)',
        padding: '12px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          className="lowercase"
          style={{
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.62rem',
            letterSpacing: '0.06em',
          }}
        >
          investigating
        </span>
        <SeverityBadge severity={insight.severity} />
        <span
          style={{
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.85rem',
          }}
        >
          {insight.headline.toLowerCase()}
        </span>
        {insight.scope.map((tag) => (
          <span
            key={tag}
            className="lowercase"
            style={{
              background: 'var(--bg-elevated)',
              color: 'var(--text-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '1px 6px',
              fontSize: '0.7rem',
              fontFamily: 'var(--font-mono), monospace',
            }}
          >
            {tag.toLowerCase()}
          </span>
        ))}
      </div>
      <p
        style={{
          color: 'var(--text-secondary)',
          fontSize: '0.8rem',
          lineHeight: 1.45,
          margin: '8px 0 0',
        }}
      >
        {insight.summary.toLowerCase()}
      </p>
    </div>
  );
}
