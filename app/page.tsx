'use client';

import { useEffect, useState } from 'react';
import type { Insight } from '@/lib/mcp/types';
import InsightCard from '@/components/feed/InsightCard';
import Skeleton from '@/components/shared/Skeleton';
import ProcessStepper, { type StepState } from '@/components/shared/ProcessStepper';
import QueryBox from '@/components/chat/QueryBox';
import StreamingResponse from '@/components/chat/StreamingResponse';

interface BriefingResponse {
  insights: Insight[];
  workspace?: {
    projectName?: string;
    totalCustomers?: number;
  };
}

// The live briefing streams these NDJSON events (see app/api/briefing/route.ts).
type BriefingEvent =
  | { type: 'workspace'; workspace: BriefingResponse['workspace'] }
  | { type: 'tool_call_start'; toolName: string; agent: string }
  | { type: 'tool_call_end'; toolName: string; agent: string; durationMs: number; error?: string }
  | { type: 'reasoning_step'; step: { content?: string } }
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
  // preserve the page's search params (e.g. ?demo=cached) on the query stream
  const [demoSuffix, setDemoSuffix] = useState('');
  // live monitoring status for the top stepper (the real query the agent runs)
  const [stepStatus, setStepStatus] = useState('');
  const [queryCount, setQueryCount] = useState(0);

  // The query box runs LIVE (auth + Anthropic). On a static cached-demo deploy
  // those aren't available, so NEXT_PUBLIC_DEMO_ONLY=1 hides it. Unset locally.
  const demoOnly = process.env.NEXT_PUBLIC_DEMO_ONLY === '1';

  useEffect(() => {
    // On a cached-demo deploy, always use the cached briefing so the bare root URL
    // works with no auth. Locally (flag unset), honor the URL's params.
    const search = demoOnly
      ? '?demo=cached'
      : typeof window !== 'undefined'
        ? window.location.search
        : '';

    // carry existing params (e.g. ?demo=cached) onto the query stream as an
    // &-prefixed suffix, since the agent endpoint already takes ?q first.
    const params = new URLSearchParams(search);
    params.delete('q');
    const carried = params.toString();
    setDemoSuffix(carried ? `&${carried}` : '');

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
              break;
            case 'reasoning_step':
              if (evt.step?.content) setStepStatus(evt.step.content);
              break;
            case 'insight':
              collected.push(evt.insight);
              break;
            case 'done':
              setInsights(collected);
              stashInsights(collected);
              setStatus(collected.length === 0 ? 'empty' : 'loaded');
              break;
            case 'error':
              setErrorMessage(evt.message ?? 'something went wrong');
              setStatus('error');
              break;
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
  }, []);

  return (
    <main
      className={`min-h-screen px-6 py-10 ${demoOnly ? 'pb-10' : 'pb-28'} mx-auto w-full max-w-2xl`}
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

      {/* loading */}
      {status === 'loading' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Skeleton height={96} />
          <Skeleton height={96} />
          <Skeleton height={96} />
          <Skeleton height={96} />
        </div>
      )}

      {/* error */}
      {status === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <p
            className="text-sm lowercase"
            style={{
              color: 'var(--accent-coral)',
              fontFamily: 'var(--font-mono), monospace',
              margin: 0,
            }}
          >
            {/unauthor|forbidden|401|session expired/i.test(errorMessage)
              ? 'your workspace session expired — reconnect to continue'
              : errorMessage || 'something went wrong'}
          </p>
          {/unauthor|forbidden|401|session expired/i.test(errorMessage) && (
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

      {/* loaded */}
      {status === 'loaded' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {insights.map((insight) => (
            <InsightCard key={insight.id} insight={insight} />
          ))}
        </div>
      )}

      {!demoOnly && <QueryBox onSubmit={(q) => setActiveQuery(q)} />}
    </main>
  );
}
