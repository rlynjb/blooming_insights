'use client';

import { useEffect, useState } from 'react';
import type { Insight } from '@/lib/mcp/types';
import InsightCard from '@/components/feed/InsightCard';
import Skeleton from '@/components/shared/Skeleton';
import QueryBox from '@/components/chat/QueryBox';
import StreamingResponse from '@/components/chat/StreamingResponse';

interface BriefingResponse {
  insights: Insight[];
  workspace?: {
    projectName?: string;
    totalCustomers?: number;
  };
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

  useEffect(() => {
    const search = typeof window !== 'undefined' ? window.location.search : '';

    // carry existing params (e.g. ?demo=cached) onto the query stream as an
    // &-prefixed suffix, since the agent endpoint already takes ?q first.
    const params = new URLSearchParams(search);
    params.delete('q');
    const carried = params.toString();
    setDemoSuffix(carried ? `&${carried}` : '');

    const url = `/api/briefing${search}`;

    fetch(url)
      .then(async (res) => {
        const body = await readBody(res);

        if (res.status === 401 && body?.needsAuth && body?.authUrl) {
          window.location.href = body.authUrl as string;
          return;
        }

        if (!res.ok) {
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

        const data = body as unknown as BriefingResponse;
        const list: Insight[] = Array.isArray(data?.insights) ? data.insights : [];
        setWorkspace(data?.workspace);
        setInsights(list);
        setStatus(list.length === 0 ? 'empty' : 'loaded');
      })
      .catch((e: unknown) => {
        setErrorMessage(String(e));
        setStatus('error');
      });
  }, []);

  return (
    <main
      className="min-h-screen px-6 py-10 pb-28 mx-auto w-full max-w-2xl"
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
          <p
            className="text-sm lowercase"
            style={{
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono), monospace',
              marginBottom: 8,
            }}
          >
            agents analyzing the workspace…
          </p>
          <Skeleton height={96} />
          <Skeleton height={96} />
          <Skeleton height={96} />
          <Skeleton height={96} />
        </div>
      )}

      {/* error */}
      {status === 'error' && (
        <p
          className="text-sm lowercase"
          style={{
            color: 'var(--accent-coral)',
            fontFamily: 'var(--font-mono), monospace',
          }}
        >
          {errorMessage || 'something went wrong'}
        </p>
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

      <QueryBox onSubmit={(q) => setActiveQuery(q)} />
    </main>
  );
}
