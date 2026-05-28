'use client';

import { useState } from 'react';

interface ToolCallBlockProps {
  toolName: string;
  status: 'running' | 'done';
  durationMs?: number;
  result?: unknown;
  error?: string;
}

function dotColor(status: 'running' | 'done', error?: string): string {
  if (error) return 'var(--accent-coral)';
  return status === 'running' ? 'var(--accent-amber)' : 'var(--accent-teal)';
}

export default function ToolCallBlock({
  toolName,
  status,
  durationMs,
  result,
  error,
}: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const running = status === 'running';

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 4,
      }}
    >
      {/* header row */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span
          className={running ? 'animate-pulse' : undefined}
          aria-hidden
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dotColor(status, error),
            flexShrink: 0,
          }}
        />
        <span
          style={{
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.72rem',
            wordBreak: 'break-all',
          }}
        >
          {toolName}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            color: error ? 'var(--accent-coral)' : 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.68rem',
            flexShrink: 0,
          }}
        >
          {running ? 'running…' : error ? 'error' : `${durationMs ?? 0}ms`}
        </span>
      </button>

      {/* expanded body */}
      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--border)',
            padding: '10px 12px',
          }}
        >
          {error ? (
            <p
              style={{
                color: 'var(--accent-coral)',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: '0.75rem',
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {error}
            </p>
          ) : (
            <pre
              className="whitespace-pre-wrap break-words"
              style={{
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: '0.72rem',
                lineHeight: 1.5,
                margin: 0,
                maxHeight: 240,
                overflow: 'auto',
              }}
            >
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
