'use client';

import { useState } from 'react';

interface QueryBoxProps {
  onSubmit: (query: string) => void;
}

export default function QueryBox({ onSubmit }: QueryBoxProps) {
  const [value, setValue] = useState('');

  const submit = () => {
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
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="ask anything about your workspace…"
          className="lowercase"
          style={{
            flex: 1,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '8px 12px',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.875rem',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={submit}
          className="lowercase"
          style={{
            background: 'var(--accent-teal)',
            color: 'var(--bg-base)',
            border: 'none',
            borderRadius: 4,
            padding: '8px 16px',
            cursor: 'pointer',
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
