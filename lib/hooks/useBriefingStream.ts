'use client';

import { useEffect, useRef, useState } from 'react';
import type { Insight, CoverageItem, CoverageReport } from '@/lib/mcp/types';
import type { TraceItem } from '@/components/investigation/ReasoningTrace';
import { readNdjson } from '@/lib/streaming/ndjson';

/**
 * Briefing stream consumer. Owns the GET /api/briefing fetch, the
 * NDJSON parse loop, and the 9-case event dispatcher. Returns a
 * stable 9-field shape; the page consumes the return value.
 *
 * Verification harness: test/api/briefing.integration.test.ts
 * (7 tests pin the NDJSON event contract this hook consumes).
 *
 * Composes with useReconnectPolicy via callbacks (auth error → handle;
 * stream complete → clearFlag). See lib/hooks/useReconnectPolicy.ts.
 *
 * Sibling pattern: lib/hooks/useInvestigation.ts (216 LOC, same
 * shape: fetch + readNdjson + event dispatcher + cleanup).
 */

export interface BriefingResponse {
  insights: Insight[];
  workspace?: {
    projectName?: string;
    totalCustomers?: number;
  };
  // present when a cached snapshot bundles the gathering trace (forward-compat)
  trace?: TraceItem[];
  // the anomaly-coverage grid summary (optional — old snapshots lack it)
  coverage?: CoverageReport;
}

// The live briefing streams these NDJSON events (see app/api/briefing/route.ts).
export type BriefingEvent =
  | { type: 'workspace'; workspace: BriefingResponse['workspace'] }
  | { type: 'coverage_item'; item: CoverageItem }
  | { type: 'coverage'; coverage: CoverageReport }
  | { type: 'tool_call_start'; toolName: string; agent: string }
  | { type: 'tool_call_end'; toolName: string; agent: string; durationMs: number; result?: unknown; error?: string }
  | { type: 'reasoning_step'; step: { id?: string; kind?: string; content?: string } }
  | { type: 'insight'; insight: Insight }
  | { type: 'done' }
  | { type: 'error'; message?: string };

export type FeedStatus = 'loading' | 'error' | 'empty' | 'loaded';

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

export interface UseBriefingStreamCallbacks {
  /** Called on case 'error'. If it returns true, the hook bails — the
   *  policy has fired the reconnect (passed `reconnectPolicy.handle`). */
  onAuthError?: (errorMessage: string) => boolean;
  /** Called on case 'done'. The page passes `reconnectPolicy.clearFlag`
   *  so the success path clears the reconnect flag. */
  onStreamComplete?: () => void;
}

export interface UseBriefingStreamResult {
  status: FeedStatus;
  insights: Insight[];
  workspace: BriefingResponse['workspace'];
  coverage: CoverageReport;
  traceItems: TraceItem[];
  errorMessage: string;
  stepStatus: string;
  queryCount: number;
  demoSuffix: string;
}

/** The runtime modes the briefing supports:
 *   - `demo`           → replay the committed snapshot (no MCP/Anthropic).
 *                        Hidden from the UI toggle; reachable via
 *                        `?demo=cached` URL param or manual localStorage set.
 *   - `live-mcp`       → run the agents against an MCP server (Bloomreach by
 *                        default; env MCP_URL + MCP_AUTH_TYPE override).
 *   - `live-synthetic` → run the real agents/model against local fake data.
 *                        The default fresh-visitor UX.
 *  Legacy `'live'`, `'live-sql'`, and `'live-bloomreach'` reads from
 *  localStorage migrate to `'live-mcp'` in page.tsx. */
export type BriefingMode = 'demo' | 'live-mcp' | 'live-synthetic';

export function useBriefingStream(
  mode: BriefingMode,
  ready: boolean,
  callbacks?: UseBriefingStreamCallbacks,
): UseBriefingStreamResult {
  const [status, setStatus] = useState<FeedStatus>('loading');
  const [insights, setInsights] = useState<Insight[]>([]);
  const [workspace, setWorkspace] = useState<BriefingResponse['workspace']>(undefined);
  const [errorMessage, setErrorMessage] = useState('');
  // carried onto the query stream; the query box is live-only, so this stays empty
  const [demoSuffix, setDemoSuffix] = useState('');
  // live monitoring status for the top stepper (the real query the agent runs)
  const [stepStatus, setStepStatus] = useState('');
  const [queryCount, setQueryCount] = useState(0);
  // the monitoring agent's gathering trace (tool calls + thoughts) for provenance
  const [traceItems, setTraceItems] = useState<TraceItem[]>([]);
  // the 10-category anomaly-coverage summary (drives the coverage grid)
  const [coverage, setCoverage] = useState<CoverageReport>([]);

  // Keep the latest callbacks in a ref so the effect (deps: [mode, ready])
  // doesn't re-run when the caller passes fresh closures each render.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // Cancellation latch — reset on every effect run so a mode flip starts
  // fresh while the previous run's cleanup has flipped its own captured
  // reference. Read via the closure-captured handle below.
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!ready) return; // wait until the persisted mode is resolved

    const isDemo = mode === 'demo';
    // demo → cached snapshot (instant, no auth); live → run the agents,
    // tagged with `?mode=` so the route picks the matching DataSource branch.
    const search = isDemo ? '?demo=cached' : `?mode=${mode}`;
    setDemoSuffix(isDemo ? '&demo=cached' : `&mode=${mode}`);

    // reset the feed for this (re)load — important when toggling demo/live
    setStatus('loading');
    setErrorMessage('');
    setInsights([]);
    setStepStatus('');
    setQueryCount(0);
    setTraceItems([]);
    setCoverage([]);

    // Reset the cancel latch for this run. Cleanup flips it true; the
    // in-flight async block polls cancelOn() against the same ref.
    cancelledRef.current = false;

    const url = `/api/briefing${search}`;

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
          if (Array.isArray(data?.coverage)) setCoverage(data.coverage);
          setStatus(list.length === 0 ? 'empty' : 'loaded');
          return;
        }

        // Live path: NDJSON stream — surface monitoring's real status as it runs.
        const collected: Insight[] = [];

        const handle = (evt: BriefingEvent) => {
          switch (evt.type) {
            case 'workspace':
              setWorkspace(evt.workspace);
              break;
            case 'coverage_item':
              // accumulate one tile at a time → the grid fills progressively
              setCoverage((prev) =>
                prev.some((c) => c.category === evt.item.category) ? prev : [...prev, evt.item],
              );
              break;
            case 'coverage':
              setCoverage(evt.coverage);
              break;
            case 'tool_call_start':
              setQueryCount((n) => n + 1);
              setTraceItems((prev) => [
                ...prev,
                { kind: 'tool', id: crypto.randomUUID(), toolName: evt.toolName, status: 'running', ts: Date.now() },
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
                    ts: Date.now(),
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
              // success path — clear the one-shot guard so the next session-
              // expiry can fire a fresh auto-reconnect.
              callbacksRef.current?.onStreamComplete?.();
              setStatus(collected.length === 0 ? 'empty' : 'loaded');
              break;
            case 'error': {
              const msg = evt.message ?? 'something went wrong';
              // The alpha server revokes tokens after a few minutes; the policy
              // hook owns the auto-reconnect dance (auth-shaped check + one-shot
              // guard + reset+reload). If it takes the error, bail; otherwise
              // surface the message normally.
              if (callbacksRef.current?.onAuthError?.(msg)) return;
              setErrorMessage(msg);
              setStatus('error');
              break;
            }
          }
        };

        await readNdjson<BriefingEvent>(res.body, handle, { cancelOn: () => cancelledRef.current });
      } catch (e) {
        if (!cancelledRef.current) {
          setErrorMessage(String(e));
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [mode, ready]);

  return {
    status,
    insights,
    workspace,
    coverage,
    traceItems,
    errorMessage,
    stepStatus,
    queryCount,
    demoSuffix,
  };
}
