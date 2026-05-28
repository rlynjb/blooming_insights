'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { AgentEvent } from '@/lib/mcp/events';
import type { Diagnosis, Recommendation } from '@/lib/mcp/types';
import ReasoningTrace, { type TraceItem } from '@/components/investigation/ReasoningTrace';
import EvidencePanel from '@/components/investigation/EvidencePanel';
import RecommendationCard from '@/components/investigation/RecommendationCard';
import ProcessStepper, { type StepState } from '@/components/shared/ProcessStepper';

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
        // Hand the agent the insight the feed stashed (sessionStorage), so the
        // anomaly survives Vercel's per-instance memory across function boundaries.
        let url = `/api/agent?insightId=${id}`;
        try {
          const stashed =
            typeof window !== 'undefined' ? sessionStorage.getItem(`bi:insight:${id}`) : null;
          if (stashed) url += `&insight=${encodeURIComponent(stashed)}`;
        } catch {
          /* sessionStorage blocked — fall back to server-side lookup */
        }

        const res = await fetch(url);

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
  const canExport = complete || diagnosis !== null;

  // Stepper stages: monitoring already produced this insight upstream;
  // diagnostic + recommendation run live on this page.
  const diagState: StepState = error && !diagnosis ? 'error' : diagnosis ? 'complete' : 'active';
  const recState: StepState =
    error && diagnosis && !complete
      ? 'error'
      : complete
        ? 'complete'
        : diagnosis
          ? 'active'
          : 'pending';
  const diagSub =
    diagState === 'error'
      ? 'failed'
      : diagState === 'complete'
        ? 'cause identified'
        : 'testing hypotheses…';
  const recSub =
    recState === 'error'
      ? 'failed'
      : recState === 'complete'
        ? `${recommendations.length} action${recommendations.length === 1 ? '' : 's'}`
        : recState === 'active'
          ? 'proposing actions…'
          : 'awaiting diagnosis';

  const buildMarkdown = (): string => {
    const lines: string[] = [];

    lines.push(`# investigation: ${id ?? 'unknown'}`);
    lines.push('');

    // reasoning trace
    lines.push('## reasoning trace');
    if (items.length === 0) {
      lines.push('- (no trace)');
    } else {
      for (const it of items) {
        if (it.kind === 'step') {
          lines.push(`- [${it.agent}/${it.stepKind}] ${it.content}`);
        } else {
          lines.push(`- tool: ${it.toolName} (${it.durationMs ?? 0}ms)`);
        }
      }
    }
    lines.push('');

    // diagnosis
    lines.push('## diagnosis');
    if (diagnosis) {
      lines.push(diagnosis.conclusion);
      if (diagnosis.evidence.length > 0) {
        lines.push('');
        lines.push('**evidence**');
        for (const e of diagnosis.evidence) lines.push(`- ${e}`);
      }
      if (diagnosis.hypothesesConsidered.length > 0) {
        lines.push('');
        lines.push('**hypotheses considered**');
        for (const h of diagnosis.hypothesesConsidered) {
          lines.push(
            `- [${h.supported ? 'supported' : 'ruled out'}] ${h.hypothesis} — ${h.reasoning}`,
          );
        }
      }
    } else {
      lines.push('(no diagnosis)');
    }
    lines.push('');

    // recommendations
    lines.push('## recommendations');
    if (recommendations.length === 0) {
      lines.push('(no recommendations)');
    } else {
      for (const r of recommendations) {
        lines.push(`### ${r.title}  (${r.bloomreachFeature} · ${r.confidence})`);
        lines.push(r.rationale);
        if (r.steps.length > 0) {
          lines.push('steps:');
          r.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
        }
        lines.push(`impact: ${r.estimatedImpact}`);
        lines.push('');
      }
    }

    return lines.join('\n');
  };

  const handleExport = () => {
    const md = buildMarkdown();
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `investigation-${id ?? 'unknown'}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <main
      className="min-h-screen px-6 py-10 mx-auto w-full max-w-5xl"
      style={{ fontFamily: 'var(--font-body), system-ui, sans-serif' }}
    >
      {/* header — consistent with the feed: branding + the shared stepper */}
      <div style={{ marginBottom: 32 }}>
        {/* utility row: back + export */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <BackLink />
          {canExport && !error && (
            <button
              type="button"
              onClick={handleExport}
              className="lowercase"
              style={{
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: '0.75rem',
                padding: '3px 10px',
              }}
            >
              export ↓
            </button>
          )}
        </div>
        <h1
          className="text-3xl lowercase"
          style={{
            fontFamily: 'var(--font-display), system-ui, sans-serif',
            color: 'var(--text-primary)',
            marginBottom: 6,
          }}
        >
          blooming insights
        </h1>
        <p className="text-sm lowercase" style={{ color: 'var(--text-secondary)' }}>
          your workspace, in bloom
        </p>
      </div>

      {/* same stepper as the feed — monitoring is done; the other two run here */}
      <ProcessStepper
        monitoring={{ state: 'complete', sub: 'change detected' }}
        diagnostic={{ state: diagState, sub: diagSub }}
        recommendation={{ state: recState, sub: recSub }}
      />

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
