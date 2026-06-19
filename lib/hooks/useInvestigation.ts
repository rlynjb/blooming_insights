'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@/lib/mcp/events';
import type { Diagnosis, Recommendation } from '@/lib/mcp/types';
import type { TraceItem } from '@/components/investigation/ReasoningTrace';
import { readNdjson } from '@/lib/streaming/ndjson';

export type InvestigationStep = 'diagnose' | 'recommend';

export interface InvestigationState {
  items: TraceItem[];
  diagnosis: Diagnosis | null;
  recommendations: Recommendation[];
  complete: boolean;
  error: string | null;
}

const stashKey = (step: InvestigationStep, id: string) => `bi:inv:${step}:${id}`;
const diagHandoffKey = (id: string) => `bi:diag:${id}`;

/** Runs one step of an investigation and exposes its trace + result.
 *
 *  - step 'diagnose' runs the diagnostic agent only and stashes the diagnosis
 *    for step 3 (the decision is NOT run here).
 *  - step 'recommend' runs the recommendation agent with the handed-over
 *    diagnosis.
 *
 *  Each step's result is stashed in sessionStorage so re-visits / back-nav
 *  hydrate instantly without re-running the agents. In demo mode the server
 *  replays the cached snapshot filtered to this step.
 *
 *  NOTE: we deliberately do NOT cancel the fetch on effect cleanup. React
 *  StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first
 *  cleanup, with the started-guard blocking the re-mount, aborted the stream
 *  and left the logs empty. The started-guard prevents a double fetch; the
 *  in-flight run simply completes (setState after unmount is a safe no-op). */
export function useInvestigation(id: string | undefined, step: InvestigationStep): InvestigationState {
  const [items, setItems] = useState<TraceItem[]>([]);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!id) return;
    if (startedRef.current) return; // run once per mount (survives StrictMode)
    startedRef.current = true;

    // 1) hydrate from this step's stash (re-visit / back-nav).
    try {
      const raw = sessionStorage.getItem(stashKey(step, id));
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

    const cItems: TraceItem[] = [];
    let cDiag: Diagnosis | null = null;
    const cRecs: Recommendation[] = [];

    // For the recommend step, load the diagnosis handed over from step 2 (shown
    // for context + passed to the live recommendation run).
    let handedDiagnosis: Diagnosis | null = null;
    if (step === 'recommend') {
      try {
        const raw = sessionStorage.getItem(diagHandoffKey(id));
        if (raw) {
          const d = JSON.parse(raw) as { diagnosis?: Diagnosis };
          handedDiagnosis = d.diagnosis ?? null;
          cDiag = handedDiagnosis;
          if (handedDiagnosis) setDiagnosis(handedDiagnosis);
        }
      } catch {
        /* ignore */
      }
    }

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
      switch (e.type) {
        case 'reasoning_step': {
          const it: TraceItem = {
            kind: 'step',
            id: e.step.id,
            agent: e.step.agent,
            stepKind: e.step.kind as 'thought' | 'hypothesis' | 'conclusion',
            content: e.step.content,
            ts: Date.now(),
          };
          cItems.push(it);
          setItems((p) => [...p, it]);
          break;
        }
        case 'tool_call_start': {
          const it: TraceItem = { kind: 'tool', id: crypto.randomUUID(), toolName: e.toolName, status: 'running', ts: Date.now() };
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
              stashKey(step, id),
              JSON.stringify({ items: cItems, diagnosis: cDiag, recommendations: cRecs }),
            );
            // hand the diagnosis to step 3
            if (step === 'diagnose' && cDiag) {
              sessionStorage.setItem(diagHandoffKey(id), JSON.stringify({ diagnosis: cDiag }));
            }
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
        let url = `/api/agent?insightId=${id}&step=${step}`;
        try {
          const saved = typeof window !== 'undefined' ? localStorage.getItem('bi:mode') : null;
          // Match the feed's live mode so investigate/recommend uses the same
          // data source. Legacy values still migrate to Bloomreach.
          const liveMode =
            saved === 'live-synthetic'
              ? 'live-synthetic'
              : saved === 'live' || saved === 'live-sql' || saved === 'live-bloomreach'
                ? 'live-bloomreach'
                : null;
          if (liveMode) {
            url += '&live=1';
            url += `&mode=${liveMode}`;
            const stashed = sessionStorage.getItem(`bi:insight:${id}`);
            if (stashed) url += `&insight=${encodeURIComponent(stashed)}`;
            if (step === 'recommend' && handedDiagnosis) {
              url += `&diagnosis=${encodeURIComponent(JSON.stringify(handedDiagnosis))}`;
            }
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
          setError((b?.error as string) || `http ${res.status}`);
          return;
        }

        await readNdjson<AgentEvent>(res.body, handle);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [id, step]);

  return { items, diagnosis, recommendations, complete, error };
}
