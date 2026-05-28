'use client';

import { useState } from 'react';

interface QueryBoxProps {
  onSubmit: (query: string) => void;
  // demo mode: keep the box visible (so the "ask anything" feature is on show)
  // but inert — free-form Q&A runs the agents live against the workspace.
  disabled?: boolean;
}

export default function QueryBox({ onSubmit, disabled = false }: QueryBoxProps) {
  const [value, setValue] = useState('');

  const submit = () => {
    if (disabled) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: 'var(--bg-base)',
        borderTop: '1px solid var(--border)',
        padding: '12px 24px',
        zIndex: 10,
      }}
    >
      <div
        className="mx-auto w-full max-w-2xl"
        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
      >
        <input
          type="text"
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            disabled
              ? 'ask anything about your workspace — switch to live to use'
              : 'ask anything about your workspace…'
          }
          className="lowercase"
          style={{
            flex: 1,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '8px 12px',
            color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.875rem',
            outline: 'none',
            cursor: disabled ? 'not-allowed' : 'text',
            opacity: disabled ? 0.7 : 1,
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="lowercase"
          style={{
            background: disabled ? 'var(--bg-elevated)' : 'var(--accent-teal)',
            color: disabled ? 'var(--text-tertiary)' : 'var(--bg-base)',
            border: disabled ? '1px solid var(--border)' : 'none',
            borderRadius: 4,
            padding: '8px 16px',
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.875rem',
          }}
        >
          ask
        </button>
      </div>
    </div>
  );
}
