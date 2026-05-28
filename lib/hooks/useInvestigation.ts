'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@/lib/mcp/events';
import type { Diagnosis, Recommendation } from '@/lib/mcp/types';
import type { TraceItem } from '@/components/investigation/ReasoningTrace';

export interface InvestigationState {
  items: TraceItem[];
  diagnosis: Diagnosis | null;
  recommendations: Recommendation[];
  complete: boolean;
  error: string | null;
}

const STASH_PREFIX = 'bi:inv:';

/** Runs (or replays) an investigation and exposes its trace, diagnosis and
 *  recommendations. The full diagnostic → recommendation run happens once (on
 *  the step-2 page); the result is stashed in sessionStorage so the step-3 page
 *  — and any re-visit of step 2 — hydrates instantly without re-running the
 *  agents (which matters under the alpha server's rate limit + token churn). */
export function useInvestigation(id: string | undefined): InvestigationState {
  const [items, setItems] = useState<TraceItem[]>([]);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!id) return;
    if (startedRef.current) return; // guard StrictMode double-invoke
    startedRef.current = true;

    // 1) hydrate from the session stash if this investigation already ran
    //    (step 3 navigated from step 2, or a back-navigation to step 2).
    try {
      const raw = sessionStorage.getItem(`${STASH_PREFIX}${id}`);
      if (raw) {
        const s = JSON.parse(raw) as Partial<InvestigationState>;
        setItems(s.items ?? []);
        setDiagnosis(s.diagnosis ?? null);
        setRecommendations(s.recommendations ?? []);
        setComplete(true);
        return;
      }
    } catch {
      /* ignore — fall through to a live/replay fetch */
    }

    let cancelled = false;
    const cItems: TraceItem[] = [];
    let cDiag: Diagnosis | null = null;
    const cRecs: Recommendation[] = [];

    const replaceRunningTool = (arr: TraceItem[], e: Extract<AgentEvent, { type: 'tool_call_end' }>) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const it = arr[i];
        if (it.kind === 'tool' && it.toolName === e.toolName && it.status === 'running') {
          arr[i] = { ...it, status: 'done', durationMs: e.durationMs, result: e.result, error: e.error };
          break;
        }
      }
      return arr;
    };

    const handle = (e: AgentEvent) => {
      if (cancelled) return;
      switch (e.type) {
        case 'reasoning_step': {
          const it: TraceItem = {
            kind: 'step',
            id: e.step.id,
            agent: e.step.agent,
            stepKind: e.step.kind as 'thought' | 'hypothesis' | 'conclusion',
            content: e.step.content,
          };
          cItems.push(it);
          setItems((p) => [...p, it]);
          break;
        }
        case 'tool_call_start': {
          const it: TraceItem = { kind: 'tool', id: crypto.randomUUID(), toolName: e.toolName, status: 'running' };
          cItems.push(it);
          setItems((p) => [...p, it]);
          break;
        }
        case 'tool_call_end':
          replaceRunningTool(cItems, e);
          setItems((p) => replaceRunningTool([...p], e));
          break;
        case 'diagnosis':
          cDiag = e.diagnosis;
          setDiagnosis(e.diagnosis);
          break;
        case 'recommendation':
          cRecs.push(e.recommendation);
          setRecommendations((p) => [...p, e.recommendation]);
          break;
        case 'done':
          setComplete(true);
          try {
            sessionStorage.setItem(
              `${STASH_PREFIX}${id}`,
              JSON.stringify({ items: cItems, diagnosis: cDiag, recommendations: cRecs }),
            );
          } catch {
            /* stash is best-effort */
          }
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
        // Match the feed's mode: demo → cache-replay (default); live → run the
        // agents, handing over the insight the feed stashed so the anomaly
        // survives Vercel's per-instance memory across function calls.
        let url = `/api/agent?insightId=${id}`;
        try {
          const live = typeof window !== 'undefined' && localStorage.getItem('bi:mode') === 'live';
          if (live) {
            url += '&live=1';
            const stashed = sessionStorage.getItem(`bi:insight:${id}`);
            if (stashed) url += `&insight=${encodeURIComponent(stashed)}`;
          }
        } catch {
          /* storage blocked — fall back to server-side lookup / cache */
        }

        const res = await fetch(url);
        if (res.status === 401) {
          const b = await res.json().catch(() => ({}));
          if (b?.needsAuth && b?.authUrl) {
            window.location.href = b.authUrl as string;
            return;
          }
        }
        if (!res.ok || !res.body) {
          const b = await res.json().catch(() => ({}));
          if (!cancelled) setError((b?.error as string) || `http ${res.status}`);
          return;
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
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
              handle(JSON.parse(line) as AgentEvent);
            } catch {
              /* ignore malformed line */
            }
          }
        }
        if (buf.trim()) {
          try {
            handle(JSON.parse(buf) as AgentEvent);
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

  return { items, diagnosis, recommendations, complete, error };
}
