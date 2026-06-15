'use client';

import { useEffect, useState } from 'react';
import InsightCard from '@/components/feed/InsightCard';
import CoverageGrid from '@/components/feed/CoverageGrid';
import Skeleton from '@/components/shared/Skeleton';
import ProcessStepper, { type StepState } from '@/components/shared/ProcessStepper';
import ReasoningTrace from '@/components/investigation/ReasoningTrace';
import StreamingResponse from '@/components/chat/StreamingResponse';
import QueryBox from '@/components/chat/QueryBox';
import { useBriefingStream, type FeedStatus } from '@/lib/hooks/useBriefingStream';
import { useDemoCapture } from '@/lib/hooks/useDemoCapture';
import { useReconnectPolicy, isAuthErrorButton } from '@/lib/hooks/useReconnectPolicy';

// the free-form "ask anything" box is hidden for now — flip to show it again.
const SHOW_QUERY_BOX = false;

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

function formatCustomerCount(n: number): string {
  return n.toLocaleString();
}

export default function HomePage() {
  const [activeQuery, setActiveQuery] = useState<string | null>(null);

  // revoked-token reconnect policy (state + one-shot guard + reset+reload).
  // The alpha Bloomreach server revokes tokens after minutes — see
  // lib/hooks/useReconnectPolicy.ts.
  const reconnectPolicy = useReconnectPolicy();

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

  // The briefing stream — fetch + NDJSON parse + 9-case event dispatcher,
  // composed with the reconnect policy (auth error → handle; done → clearFlag).
  // See lib/hooks/useBriefingStream.ts.
  const {
    status,
    insights,
    workspace,
    coverage,
    traceItems,
    errorMessage,
    stepStatus,
    queryCount,
    demoSuffix,
  } = useBriefingStream(mode, ready, {
    onAuthError: reconnectPolicy.handle,
    onStreamComplete: reconnectPolicy.clearFlag,
  });

  // dev-only single-click demo-snapshot capture (briefing → investigations → bundle).
  // The button below is gated on NODE_ENV !== 'production' && !isDemo; the hook
  // itself is environment-agnostic — see lib/hooks/useDemoCapture.ts.
  const { capturing, captureAll } = useDemoCapture(insights, workspace, traceItems);

  return (
    <main
      className="min-h-screen px-6 py-10 mx-auto w-full max-w-5xl"
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
      {reconnectPolicy.reconnecting && (
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

      {/* feed (col 1) + live statuses & logs (col 2), side by side — matches the
          investigate page width, and keeps the live trace visible so the user
          can see work happening in the background. */}
      <div className="grid grid-cols-1 lg:grid-cols-3" style={{ gap: 24, alignItems: 'start' }}>
        {/* ── col 1 — the feed (anomaly items) ───────────────────────────── */}
        <div className="lg:col-span-2" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* anomaly coverage grid — the category checklist, above the cards. Tiles
          stream in one at a time as the gate reports each category; while
          loading, the not-yet-reported tiles render as pending skeletons. */}
      <CoverageGrid coverage={coverage} insights={insights} loading={status === 'loading' && !reconnectPolicy.reconnecting} />
      {/* loading */}
      {status === 'loading' && !reconnectPolicy.reconnecting && (
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
          {isAuthErrorButton(errorMessage) && (
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
                onClick={reconnectPolicy.reconnect}
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
        </div>

        {/* ── col 2 — live statuses / logs, so the user sees background work ── */}
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
            how this briefing was gathered ·{' '}
            {traceItems.length > 0
              ? `${queryCount} ${queryCount === 1 ? 'query' : 'queries'}`
              : '-- queries'}
            {status === 'loading' && ' · scanning…'}
          </div>
          <div style={{ padding: '10px 16px 16px' }}>
            {traceItems.length > 0 ? (
              <ReasoningTrace items={traceItems} />
            ) : status === 'loading' ? (
              <p
                className="lowercase"
                style={{
                  margin: 0,
                  color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.72rem',
                  lineHeight: 1.5,
                }}
              >
                connecting to the agent…
              </p>
            ) : (
              <p
                className="lowercase"
                style={{
                  margin: 0,
                  color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: '0.72rem',
                  lineHeight: 1.5,
                }}
              >
                -- the agent&apos;s query-by-query trace is recorded during a live briefing. switch
                to live to watch the real eql it runs, or capture a live snapshot to bake it into
                demo.
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* free-form "ask anything" box — hidden behind a flag for now. The
          QueryBox / StreamingResponse components and the /api/agent ?q= flow
          stay wired up; flip SHOW_QUERY_BOX to bring it back. */}
      {SHOW_QUERY_BOX && <QueryBox onSubmit={(q) => setActiveQuery(q)} disabled={isDemo} />}
    </main>
  );
}
