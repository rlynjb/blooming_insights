'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@/lib/mcp/events';
import ReasoningTrace, { type TraceItem } from '@/components/investigation/ReasoningTrace';
import Skeleton from '@/components/shared/Skeleton';

interface StreamingResponseProps {
  query: string;
  demoSuffix?: string;
}

export default function StreamingResponse({ query, demoSuffix }: StreamingResponseProps) {
  const [items, setItems] = useState<TraceItem[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReasoning, setShowReasoning] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!query) return;
    // guard against React StrictMode double-invocation in dev
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;

    const handleEvent = (e: AgentEvent) => {
      if (cancelled) return;
      switch (e.type) {
        case 'reasoning_step':
          setItems((prev) => [
            ...prev,
            {
              kind: 'step',
              id: e.step.id,
              agent: e.step.agent,
              stepKind: e.step.kind as 'thought' | 'hypothesis' | 'conclusion',
              content: e.step.content,
            },
          ]);
          // the final answer arrives as a conclusion from the coordinator
          if (e.step.kind === 'conclusion' && e.step.agent === 'coordinator') {
            setAnswer(e.step.content);
          }
          break;
        case 'tool_call_start':
          setItems((prev) => [
            ...prev,
            {
              kind: 'tool',
              id: crypto.randomUUID(),
              toolName: e.toolName,
              status: 'running',
            },
          ]);
          break;
        case 'tool_call_end':
          setItems((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const it = next[i];
              if (it.kind === 'tool' && it.toolName === e.toolName && it.status === 'running') {
                next[i] = {
                  ...it,
                  status: 'done',
                  durationMs: e.durationMs,
                  result: e.result,
                  error: e.error,
                };
                break;
              }
            }
            return next;
          });
          break;
        case 'done':
          setComplete(true);
          break;
        case 'error':
          setError(e.message);
          break;
        default:
          break;
      }
    };

    (async () => {
      try {
        const res = await fetch(`/api/agent?q=${encodeURIComponent(query)}${demoSuffix ?? ''}`);

        if (res.status === 401) {
          const b = await res.json().catch(() => ({}));
          if (b?.needsAuth && b?.authUrl) {
            window.location.href = b.authUrl;
            return;
          }
        }

        if (!res.ok || !res.body) {
          const b = await res.json().catch(() => ({}));
          setError((b?.error as string) || `http ${res.status}`);
          return;
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              handleEvent(JSON.parse(line) as AgentEvent);
            } catch {
              /* ignore malformed line */
            }
          }
        }
        // flush any trailing buffered line
        if (buf.trim()) {
          try {
            handleEvent(JSON.parse(buf) as AgentEvent);
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [query, demoSuffix]);

  const streaming = !complete && !error;

  return (
    <article
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '16px 20px',
      }}
    >
      {/* the original question */}
      <p
        className="lowercase"
        style={{
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono), monospace',
          fontSize: '0.75rem',
          margin: '0 0 12px',
          lineHeight: 1.4,
        }}
      >
        you asked: {query.toLowerCase()}
      </p>

      {error ? (
        <p
          className="text-sm lowercase"
          style={{
            color: 'var(--accent-coral)',
            fontFamily: 'var(--font-mono), monospace',
            margin: 0,
          }}
        >
          {error}
        </p>
      ) : (
        <>
          {/* thinking state while no answer yet */}
          {!answer && streaming && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span
                  className="animate-pulse"
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'var(--accent-amber)',
                  }}
                />
                <span
                  className="lowercase"
                  style={{
                    color: 'var(--text-tertiary)',
                    fontFamily: 'var(--font-mono), monospace',
                    fontSize: '0.75rem',
                  }}
                >
                  thinking…
                </span>
              </span>
              <Skeleton height={64} />
            </div>
          )}

          {/* no answer but stream ended */}
          {!answer && !streaming && (
            <p
              className="text-sm lowercase"
              style={{
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono), monospace',
                margin: 0,
              }}
            >
              no answer
            </p>
          )}

          {/* the answer */}
          {answer && (
            <p
              style={{
                color: 'var(--text-primary)',
                fontSize: '0.95rem',
                lineHeight: 1.6,
                margin: 0,
                whiteSpace: 'pre-wrap',
              }}
            >
              {answer}
            </p>
          )}

          {/* collapsible reasoning */}
          {items.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setShowReasoning((v) => !v)}
                className="lowercase"
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.75rem',
                }}
              >
                {showReasoning ? '▾ hide reasoning' : '▸ show reasoning'}
              </button>

              {showReasoning && (
                <div style={{ marginTop: 16 }}>
                  <ReasoningTrace items={items} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}
