'use client';

import { useState } from 'react';

const PRESETS = ['whoami', 'list_projects', 'get_project_overview', 'list_dashboards'];

export default function DebugPage() {
  const [name, setName] = useState('whoami');
  const [argsText, setArgsText] = useState('{}');
  const [output, setOutput] = useState<string>('');
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(false);

  async function call() {
    setError('');
    setOutput('');
    setDurationMs(null);

    let args: unknown;
    try {
      args = argsText.trim() === '' ? {} : JSON.parse(argsText);
    } catch {
      setError('args is not valid json');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/mcp/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, args }),
      });

      if (res.status === 401) {
        const body = await res.json();
        if (body?.needsAuth && body?.authUrl) {
          // full-page redirect so the cookie + callback round-trip works; after the
          // callback redirects back to /debug the user clicks the tool again.
          window.location.href = body.authUrl;
          return;
        }
        setError(JSON.stringify(body));
        return;
      }

      const body = await res.json();
      if (!res.ok) {
        setError(typeof body?.error === 'string' ? body.error : JSON.stringify(body));
        return;
      }
      setOutput(JSON.stringify(body.result, null, 2));
      setDurationMs(typeof body.durationMs === 'number' ? body.durationMs : null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function listTools() {
    setError('');
    setOutput('');
    setDurationMs(null);
    setLoading(true);
    try {
      const res = await fetch('/api/mcp/tools');
      if (res.status === 401) {
        const body = await res.json();
        if (body?.needsAuth && body?.authUrl) {
          window.location.href = body.authUrl;
          return;
        }
        setError(JSON.stringify(body));
        return;
      }
      const body = await res.json();
      if (!res.ok) {
        setError(typeof body?.error === 'string' ? body.error : JSON.stringify(body));
        return;
      }
      setOutput(JSON.stringify(body.tools, null, 2));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      className="min-h-screen px-6 py-8 mx-auto w-full max-w-3xl"
      style={{ fontFamily: 'var(--font-body), system-ui, sans-serif' }}
    >
      <h1 className="text-xl mb-1" style={{ color: 'var(--text-primary)' }}>
        mcp debug
      </h1>
      <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
        call a bloomreach mcp tool for the current session
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setName(p)}
            className="px-3 py-1 text-sm"
            style={{
              background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              fontFamily: 'var(--font-mono), monospace',
            }}
          >
            {p}
          </button>
        ))}
      </div>

      <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>
        tool name
      </label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full px-3 py-2 mb-4 text-sm"
        style={{
          background: 'var(--bg-surface)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          fontFamily: 'var(--font-mono), monospace',
        }}
      />

      <label className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>
        args (json)
      </label>
      <textarea
        value={argsText}
        onChange={(e) => setArgsText(e.target.value)}
        rows={5}
        className="w-full px-3 py-2 mb-4 text-sm"
        style={{
          background: 'var(--bg-surface)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          fontFamily: 'var(--font-mono), monospace',
        }}
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={call}
          disabled={loading}
          className="px-4 py-2 text-sm"
          style={{
            background: 'var(--accent-teal)',
            color: 'var(--bg-base)',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'calling…' : 'call'}
        </button>
        <button
          type="button"
          onClick={listTools}
          disabled={loading}
          className="px-4 py-2 text-sm"
          style={{
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            opacity: loading ? 0.6 : 1,
          }}
        >
          list tools
        </button>
      </div>

      {error && (
        <pre
          className="mt-6 p-3 text-sm whitespace-pre-wrap break-words"
          style={{
            background: 'var(--bg-surface)',
            color: 'var(--accent-coral)',
            border: '1px solid var(--border)',
            fontFamily: 'var(--font-mono), monospace',
          }}
        >
          {error}
        </pre>
      )}

      {output && (
        <>
          {durationMs !== null && (
            <p
              className="mt-6 mb-1 text-xs"
              style={{
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono), monospace',
              }}
            >
              {durationMs}ms
            </p>
          )}
          <pre
            className="p-3 text-sm whitespace-pre-wrap break-words"
            style={{
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              fontFamily: 'var(--font-mono), monospace',
            }}
          >
            {output}
          </pre>
        </>
      )}
    </main>
  );
}
