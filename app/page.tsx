'use client';

import { useEffect, useState } from 'react';
import type { Insight } from '@/lib/mcp/types';
import InsightCard from '@/components/feed/InsightCard';
import Skeleton from '@/components/shared/Skeleton';
import ProcessStepper, { type StepState } from '@/components/shared/ProcessStepper';
import ReasoningTrace, { type TraceItem } from '@/components/investigation/ReasoningTrace';
import QueryBox from '@/components/chat/QueryBox';
import StreamingResponse from '@/components/chat/StreamingResponse';

interface BriefingResponse {
  insights: Insight[];
  workspace?: {
    projectName?: string;
    totalCustomers?: number;
  };
  // present when a cached snapshot bundles the gathering trace (forward-compat)
  trace?: TraceItem[];
}

// The live briefing streams these NDJSON events (see app/api/briefing/route.ts).
type BriefingEvent =
  | { type: 'workspace'; workspace: BriefingResponse['workspace'] }
  | { type: 'tool_call_start'; toolName: string; agent: string }
  | { type: 'tool_call_end'; toolName: string; agent: string; durationMs: number; result?: unknown; error?: string }
  | { type: 'reasoning_step'; step: { id?: string; kind?: string; content?: string } }
  | { type: 'insight'; insight: Insight }
  | { type: 'done' }
  | { type: 'error'; message?: string };

type FeedStatus = 'loading' | 'error' | 'empty' | 'loaded';

// Monitoring is the only stage that runs on the feed; derive its stepper state
// and live status line from the feed's fetch status.
function monitoringState(status: FeedStatus): StepState {
  if (status === 'loading') return 'active';
  if (status === 'error') return 'error';
  return 'complete'; // loaded | empty
}

function monitoringSub(
  status: FeedStatus,
  statusText: string,
  queryCount: number,
  insightCount: number,
): string {
  if (status === 'loading') {
    const q = statusText.trim();
    if (q) return queryCount > 0 ? `query ${queryCount} · ${q}` : q;
    return 'scanning your workspace…';
  }
  if (status === 'empty') return 'no notable changes';
  if (status === 'error') return 'scan failed';
  return `${insightCount} change${insightCount === 1 ? '' : 's'} found`;
}

/** Stash each insight so the investigation page can hand its anomaly to the
 *  agent route (?insight=…). On Vercel the feed and the investigation request
 *  can hit different instances, so server-side in-memory lookup is unreliable;
 *  the browser carries the data across instead. */
function stashInsights(list: Insight[]): void {
  if (typeof window === 'undefined') return;
  try {
    for (const i of list) sessionStorage.setItem(`bi:insight:${i.id}`, JSON.stringify(i));
  } catch {
    /* sessionStorage full/blocked — investigation falls back to server lookup */
  }
}

/** Read a response body defensively: parse JSON when possible, otherwise return
 *  the raw text under __raw so a 500/empty/HTML body never throws on res.json(). */
async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { __raw: text };
  }
}

function formatCustomerCount(n: number): string {
  return n.toLocaleString();
}

export default function HomePage() {
  const [status, setStatus] = useState<'loading' | 'error' | 'empty' | 'loaded'>('loading');
  const [insights, setInsights] = useState<Insight[]>([]);
  const [workspace, setWorkspace] = useState<BriefingResponse['workspace']>(undefined);
  const [errorMessage, setErrorMessage] = useState('');
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  // carried onto the query stream; the query box is live-only, so this stays empty
  const [demoSuffix, setDemoSuffix] = useState('');
  // live monitoring status for the top stepper (the real query the agent runs)
  const [stepStatus, setStepStatus] = useState('');
  const [queryCount, setQueryCount] = useState(0);
  // the monitoring agent's gathering trace (tool calls + thoughts) for provenance
  const [traceItems, setTraceItems] = useState<TraceItem[]>([]);
  // true briefly while auto-reconnecting after the alpha server revokes the token
  const [reconnecting, setReconnecting] = useState(false);
  // dev-only single-click demo capture progress (briefing → investigations → bundle)
  const [capturing, setCapturing] = useState<{ active: boolean; msg: string }>({
    active: false,
    msg: '',
  });

  // Demo vs live, toggled at RUNTIME (persisted in localStorage). Demo serves the
  // cached snapshot — instant + reliable, ideal for a presentation. Live runs the
  // agents against Bloomreach (real data, but the alpha server may need a
  // reconnect). NEXT_PUBLIC_DEMO_ONLY=1 hard-locks demo and hides the toggle.
  const forcedDemo = process.env.NEXT_PUBLIC_DEMO_ONLY === '1';
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [ready, setReady] = useState(false);
  const isDemo = mode === 'demo';

  // Resolve the persisted mode before the first fetch (so we don't waste a demo
  // fetch when the user previously chose live).
  useEffect(() => {
    if (!forcedDemo) {
      try {
        const saved = localStorage.getItem('bi:mode');
        if (saved === 'live' || saved === 'demo') setMode(saved);
      } catch {
        /* localStorage blocked — default to demo */
      }
    }
    setReady(true);
  }, [forcedDemo]);

  function switchMode(next: 'demo' | 'live') {
    if (next === mode) return;
    try {
      localStorage.setItem('bi:mode', next);
    } catch {
      /* ignore */
    }
    setActiveQuery(null);
    setMode(next); // re-runs the briefing fetch below
  }

  // ── dev-only: capture the current LIVE briefing as the demo snapshot in ONE
  //    click. The feed-level features (real current/prior + agent impact) come
  //    from the briefing itself, so step 1 alone reaches feed parity; steps 2-3
  //    run each investigation so demo card-clicks replay a real drill-down too.
  async function postCapture(): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    const res = await fetch('/api/mcp/capture-demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ insights, workspace, trace: traceItems }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, body };
  }

  /** Run (or replay-from-cache) one insight's investigation to completion so it
   *  lands in .investigation-cache.json. Drains the NDJSON stream, resolving on
   *  the `done` event (ok) or an `error` event (with the message). */
  async function runInvestigation(insight: Insight): Promise<{ ok: boolean; error?: string }> {
    const url =
      `/api/agent?insightId=${encodeURIComponent(insight.id)}` +
      `&insight=${encodeURIComponent(JSON.stringify(insight))}`;
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err =
        (body.error as string) ||
        (body.needsAuth ? 'unauthorized (needs reconnect)' : `http ${res.status}`);
      return { ok: false, error: err };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let result: { ok: boolean; error?: string } = { ok: false, error: 'stream ended without done' };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as { type?: string; message?: string };
          if (evt.type === 'done') result = { ok: true };
          else if (evt.type === 'error') result = { ok: false, error: String(evt.message ?? 'error') };
        } catch {
          /* partial line — ignore */
        }
      }
    }
    return result;
  }

  async function captureAll() {
    if (capturing.active) return;
    const AUTH_RE = /invalid_token|unauthor|forbidden|401|session expired|reconnect/i;
    try {
      // 1) capture the briefing now — this alone gives feed parity (real
      //    current/prior in evidence + the agent's business impact + the trace).
      setCapturing({ active: true, msg: 'capturing the briefing (impact + comparison)…' });
      const first = await postCapture();
      if (!first.ok) {
        window.alert(`capture failed: ${first.body.error ?? 'unknown'}`);
        return;
      }

      // 2) run each investigation so demo card-clicks replay a real drill-down.
      //    sequential — the MCP server is ~1 req/s; cached ones replay fast.
      let stoppedFor = '';
      for (let n = 0; n < insights.length; n++) {
        const ins = insights[n];
        setCapturing({
          active: true,
          msg: `investigating ${n + 1}/${insights.length} · ${ins.metric}…`,
        });
        const r = await runInvestigation(ins);
        if (!r.ok && r.error && AUTH_RE.test(r.error)) {
          stoppedFor = r.error;
          break; // token revoked mid-run — keep what's cached, let the user resume
        }
        // non-auth failures: skip that one, keep going
      }

      // 3) re-capture to bundle the now-cached investigations.
      setCapturing({ active: true, msg: 'bundling investigations…' });
      const final = await postCapture();
      const b = final.body;
      const lines = [
        final.ok
          ? `captured ${b.insights} insights · ${b.traceItems} trace items · ${b.investigations} investigations`
          : `capture failed: ${b.error ?? 'unknown'}`,
        b.note ? String(b.note) : '',
        stoppedFor
          ? `stopped early — auth expired (${stoppedFor}). reconnect, then click capture again to finish the rest (cached ones are kept).`
          : '',
        final.ok ? `commit: ${((b.files as string[]) ?? []).join(', ')}` : '',
      ].filter(Boolean);
      window.alert(lines.join('\n'));
    } catch (e) {
      window.alert(`capture failed: ${String(e)}`);
    } finally {
      setCapturing({ active: false, msg: '' });
    }
  }

  useEffect(() => {
    if (!ready) return; // wait until the persisted mode is resolved

    // demo → cached snapshot (instant, no auth); live → run the agents.
    const search = isDemo ? '?demo=cached' : '';
    setDemoSuffix(isDemo ? '&demo=cached' : '');

    // reset the feed for this (re)load — important when toggling demo/live
    setStatus('loading');
    setErrorMessage('');
    setInsights([]);
    setStepStatus('');
    setQueryCount(0);
    setTraceItems([]);

    const url = `/api/briefing${search}`;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(url);

        // Auth + error cases come back as JSON (the route checks auth before it
        // commits to a stream), so handle those first.
        if (res.status === 401) {
          const body = await readBody(res);
          if (body?.needsAuth && body?.authUrl) {
            window.location.href = body.authUrl as string;
            return;
          }
          setErrorMessage('authentication required');
          setStatus('error');
          return;
        }
        if (!res.ok) {
          const body = await readBody(res);
          const msg =
            typeof body?.error === 'string'
              ? body.error
              : typeof body?.__raw === 'string'
                ? body.__raw
                : `http ${res.status}`;
          setErrorMessage(msg);
          setStatus('error');
          return;
        }

        const ct = res.headers.get('content-type') ?? '';

        // Demo / snapshot path: plain JSON, no live stream.
        if (!ct.includes('ndjson') || !res.body) {
          const body = await readBody(res);
          const data = body as unknown as BriefingResponse;
          const list: Insight[] = Array.isArray(data?.insights) ? data.insights : [];
          setWorkspace(data?.workspace);
          setInsights(list);
          stashInsights(list);
          if (Array.isArray(data?.trace)) setTraceItems(data.trace);
          setStatus(list.length === 0 ? 'empty' : 'loaded');
          return;
        }

        // Live path: NDJSON stream — surface monitoring's real status as it runs.
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const collected: Insight[] = [];
        let buf = '';

        const handle = (evt: BriefingEvent) => {
          switch (evt.type) {
            case 'workspace':
              setWorkspace(evt.workspace);
              break;
            case 'tool_call_start':
              setQueryCount((n) => n + 1);
              setTraceItems((prev) => [
                ...prev,
                { kind: 'tool', id: crypto.randomUUID(), toolName: evt.toolName, status: 'running' },
              ]);
              break;
            case 'reasoning_step': {
              const step = evt.step;
              const content = step?.content;
              if (content) {
                setStepStatus(content);
                setTraceItems((prev) => [
                  ...prev,
                  {
                    kind: 'step',
                    id: step.id ?? crypto.randomUUID(),
                    agent: 'monitoring',
                    stepKind: (step.kind as 'thought' | 'hypothesis' | 'conclusion') ?? 'thought',
                    content,
                  },
                ]);
              }
              break;
            }
            case 'tool_call_end':
              setTraceItems((prev) => {
                const next = [...prev];
                for (let i = next.length - 1; i >= 0; i--) {
                  const it = next[i];
                  if (it.kind === 'tool' && it.toolName === evt.toolName && it.status === 'running') {
                    next[i] = {
                      ...it,
                      status: 'done',
                      durationMs: evt.durationMs,
                      result: evt.result,
                      error: evt.error,
                    };
                    break;
                  }
                }
                return next;
              });
              break;
            case 'insight':
              collected.push(evt.insight);
              break;
            case 'done':
              setInsights(collected);
              stashInsights(collected);
              try {
                sessionStorage.removeItem('bi:reconnecting');
              } catch {
                /* ignore */
              }
              setStatus(collected.length === 0 ? 'empty' : 'loaded');
              break;
            case 'error': {
              const msg = evt.message ?? 'something went wrong';
              // The alpha server revokes tokens after a few minutes; its own 401
              // says to clear tokens and reconnect ("the client should
              // automatically re-register and obtain new tokens"). Do that ONCE
              // automatically — guarded so it can't loop if the fresh token is
              // also immediately revoked.
              if (/invalid_token|unauthor|forbidden|401|session expired|reconnect/i.test(msg)) {
                let alreadyTried = false;
                try {
                  alreadyTried = sessionStorage.getItem('bi:reconnecting') === '1';
                } catch {
                  /* ignore */
                }
                if (!alreadyTried) {
                  try {
                    sessionStorage.setItem('bi:reconnecting', '1');
                  } catch {
                    /* ignore */
                  }
                  setReconnecting(true);
                  fetch('/api/mcp/reset', { method: 'POST' }).finally(() => {
                    window.location.href = '/';
                  });
                  return;
                }
                try {
                  sessionStorage.removeItem('bi:reconnecting');
                } catch {
                  /* ignore */
                }
              }
              setErrorMessage(msg);
              setStatus('error');
              break;
            }
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled) {
            await reader.cancel();
            return;
          }
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              handle(JSON.parse(line) as BriefingEvent);
            } catch {
              /* skip a partial/garbage line */
            }
          }
        }
        if (buf.trim()) {
          try {
            handle(JSON.parse(buf) as BriefingEvent);
          } catch {
            /* ignore trailing partial */
          }
        }
      } catch (e) {
        if (!cancelled) {
          setErrorMessage(String(e));
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mode, ready]);

  return (
    <main
      className={`min-h-screen px-6 py-10 ${isDemo ? 'pb-10' : 'pb-28'} mx-auto w-full max-w-2xl`}
      style={{ fontFamily: 'var(--font-body), system-ui, sans-serif' }}
    >
      {/* header */}
      <div style={{ marginBottom: 32 }}>
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
        <p
          className="text-sm lowercase"
          style={{ color: 'var(--text-secondary)', marginBottom: workspace ? 8 : 0 }}
        >
          your workspace, in bloom
        </p>
        {workspace?.projectName && (
          <p
            className="text-xs"
            style={{
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono), monospace',
            }}
          >
            {workspace.projectName.toLowerCase()}
            {workspace.totalCustomers !== undefined
              ? ` · ${formatCustomerCount(workspace.totalCustomers)} customers`
              : ''}
          </p>
        )}

        {!forcedDemo && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <div
              style={{
                display: 'inline-flex',
                border: '1px solid var(--border)',
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              {(['demo', 'live'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => switchMode(m)}
                  className="lowercase"
                  style={{
                    background: mode === m ? 'var(--accent-teal)' : 'transparent',
                    color: mode === m ? 'var(--bg-base)' : 'var(--text-secondary)',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono), monospace',
                    fontSize: '0.72rem',
                    padding: '4px 12px',
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
            <span
              className="lowercase"
              style={{
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: '0.68rem',
              }}
            >
              {isDemo ? 'cached snapshot · instant' : 'live · real workspace data'}
            </span>
          </div>
        )}
      </div>

      {/* process stepper — monitoring runs here; the other two run on investigate */}
      <ProcessStepper
        monitoring={{
          state: monitoringState(status),
          sub: monitoringSub(status, stepStatus, queryCount, insights.length),
        }}
        diagnostic={{ state: 'pending', sub: 'opens when you investigate' }}
        recommendation={{ state: 'pending', sub: 'opens when you investigate' }}
      />

      {/* active query response — pinned above the feed */}
      {activeQuery && (
        <div style={{ marginBottom: 24 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginBottom: 8,
            }}
          >
            <button
              type="button"
              onClick={() => setActiveQuery(null)}
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
              × clear
            </button>
          </div>
          <StreamingResponse key={activeQuery} query={activeQuery} demoSuffix={demoSuffix} />
        </div>
      )}

      {/* auto-reconnecting after a revoked token (brief, before the redirect) */}
      {reconnecting && (
        <p
          className="lowercase"
          style={{
            color: 'var(--accent-amber)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.8rem',
          }}
        >
          session expired — reconnecting to bloomreach…
        </p>
      )}

      {/* loading */}
      {status === 'loading' && !reconnecting && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Skeleton height={96} />
          <Skeleton height={96} />
          <Skeleton height={96} />
          <Skeleton height={96} />
        </div>
      )}

      {/* error — show the REAL server error (endpoint · tool → detail), not lowercased */}
      {status === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <p
            style={{
              color: 'var(--accent-coral)',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.8rem',
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {errorMessage || 'something went wrong'}
          </p>
          {/unauthor|forbidden|401|session expired/i.test(errorMessage) && (
            <>
              <p
                className="lowercase"
                style={{
                  color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.72rem',
                  margin: 0,
                }}
              >
                the bloomreach token was revoked — reconnect to continue
              </p>
              <button
                type="button"
                onClick={async () => {
                  // clear the revoked token, then reload → re-runs OAuth cleanly
                  try {
                    await fetch('/api/mcp/reset', { method: 'POST' });
                  } catch {
                    /* ignore — reload still triggers the auth check */
                  }
                  window.location.href = '/';
                }}
                className="lowercase"
                style={{
                  background: 'var(--bg-elevated)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.8rem',
                  padding: '6px 14px',
                }}
              >
                reconnect
              </button>
            </>
          )}
        </div>
      )}

      {/* empty */}
      {status === 'empty' && (
        <p
          className="text-sm lowercase"
          style={{ color: 'var(--text-secondary)' }}
        >
          no notable changes right now
        </p>
      )}

      {/* loaded — the insight cards (each shows its own provenance) */}
      {status === 'loaded' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {insights.map((insight) => (
            <InsightCard key={insight.id} insight={insight} />
          ))}
        </div>
      )}

      {/* how the data was gathered — the monitoring agent's real tool calls */}
      {(status === 'loaded' || status === 'empty') && traceItems.length > 0 && (
        <details
          style={{
            marginTop: 28,
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--bg-elevated)',
          }}
        >
          <summary
            className="lowercase"
            style={{
              cursor: 'pointer',
              padding: '12px 16px',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: '0.72rem',
              color: 'var(--text-secondary)',
            }}
          >
            how this briefing was gathered · {queryCount} {queryCount === 1 ? 'query' : 'queries'}
          </summary>
          <div style={{ padding: '8px 16px 18px' }}>
            <ReasoningTrace items={traceItems} />
          </div>
        </details>
      )}

      {/* dev-only: snapshot the current LIVE briefing as the demo data in ONE
          click — captures the briefing (impact + comparison), runs each
          investigation, then bundles them. Writes lib/state/demo-insights.json
          (+ demo-investigations.json); commit those. */}
      {process.env.NODE_ENV !== 'production' && !isDemo && status === 'loaded' && (
        <button
          type="button"
          disabled={capturing.active}
          onClick={captureAll}
          className="lowercase"
          style={{
            marginTop: 20,
            background: 'transparent',
            border: '1px dashed var(--border)',
            borderRadius: 4,
            cursor: capturing.active ? 'progress' : 'pointer',
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: '0.72rem',
            padding: '6px 12px',
            opacity: capturing.active ? 0.7 : 1,
          }}
        >
          {capturing.active
            ? `⏳ ${capturing.msg}`
            : 'ⓘ dev · capture this as the demo snapshot (one click)'}
        </button>
      )}

      {!isDemo && <QueryBox onSubmit={(q) => setActiveQuery(q)} />}
    </main>
  );
}
