'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { AgentEvent } from '@/lib/mcp/events';
import type { Diagnosis, Recommendation } from '@/lib/mcp/types';
import ReasoningTrace, { type TraceItem } from '@/components/investigation/ReasoningTrace';
import EvidencePanel from '@/components/investigation/EvidencePanel';
import RecommendationCard from '@/components/investigation/RecommendationCard';

function BackLink() {
  return (
    <Link
      href="/"
      className="lowercase"
      style={{
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-mono), monospace',
        fontSize: '0.8rem',
        textDecoration: 'none',
      }}
    >
      ← feed
    </Link>
  );
}

export default function InvestigatePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [items, setItems] = useState<TraceItem[]>([]);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!id) return;
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
        case 'diagnosis':
          setDiagnosis(e.diagnosis);
          break;
        case 'recommendation':
          setRecommendations((prev) => [...prev, e.recommendation]);
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
        const res = await fetch(`/api/agent?insightId=${id}`);

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
  }, [id]);

  const streaming = !complete && !error;
  const statusColor = error
    ? 'var(--accent-coral)'
    : complete
      ? 'var(--accent-teal)'
      : 'var(--accent-amber)';
  const statusLabel = error ? 'error' : complete ? 'complete' : 'analyzing…';

  return (
    <main
      className="min-h-screen px-6 py-10 mx-auto w-full max-w-5xl"
      style={{ fontFamily: 'var(--font-body), system-ui, sans-serif' }}
    >
      {/* header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ marginBottom: 12 }}>
          <BackLink />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <h1
            className="text-2xl lowercase"
            style={{
              fontFamily: 'var(--font-display), system-ui, sans-serif',
              color: 'var(--text-primary)',
              margin: 0,
            }}
          >
            investigation
          </h1>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              marginLeft: 'auto',
            }}
          >
            <span
              className={streaming ? 'animate-pulse' : undefined}
              aria-hidden
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: statusColor,
              }}
            />
            <span
              className="lowercase"
              style={{
                color: statusColor,
                fontFamily: 'var(--font-mono), monospace',
                fontSize: '0.75rem',
              }}
            >
              {statusLabel}
            </span>
          </span>
        </div>
      </div>

      {error ? (
        <div
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--accent-coral)',
            borderRadius: 4,
            padding: '16px 20px',
          }}
        >
          <p
            className="text-sm lowercase"
            style={{
              color: 'var(--accent-coral)',
              fontFamily: 'var(--font-mono), monospace',
              margin: '0 0 12px',
            }}
          >
            {error}
          </p>
          <BackLink />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3" style={{ gap: 24 }}>
          {/* left: reasoning trace */}
          <div className="lg:col-span-2">
            {items.length === 0 ? (
              <p
                className="text-sm lowercase"
                style={{
                  color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-mono), monospace',
                }}
              >
                connecting to agent…
              </p>
            ) : (
              <ReasoningTrace items={items} />
            )}
          </div>

          {/* right: evidence + recommendations */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <EvidencePanel diagnosis={diagnosis} loading={streaming} />

            <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h2
                className="lowercase"
                style={{
                  color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.7rem',
                  letterSpacing: '0.06em',
                  margin: 0,
                }}
              >
                recommendations
              </h2>

              {recommendations.length > 0 ? (
                recommendations.map((r) => <RecommendationCard key={r.id} recommendation={r} />)
              ) : streaming ? (
                <p
                  className="text-sm lowercase"
                  style={{
                    color: 'var(--text-tertiary)',
                    fontFamily: 'var(--font-mono), monospace',
                    margin: 0,
                  }}
                >
                  {diagnosis ? 'proposing actions…' : 'awaiting diagnosis…'}
                </p>
              ) : (
                <p
                  className="text-sm lowercase"
                  style={{
                    color: 'var(--text-tertiary)',
                    fontFamily: 'var(--font-mono), monospace',
                    margin: 0,
                  }}
                >
                  no recommendations
                </p>
              )}
            </section>
          </div>
        </div>
      )}
    </main>
  );
}
