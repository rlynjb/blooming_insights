'use client';

import { useCallback, useState } from 'react';
import type { Insight } from '@/lib/mcp/types';
import type { TraceItem } from '@/components/investigation/ReasoningTrace';
import { readNdjson } from '@/lib/streaming/ndjson';
import { isAuthErrorAuto } from '@/lib/hooks/useReconnectPolicy';

/**
 * Dev-only single-click demo-snapshot capture.
 *
 * Three phases:
 *   1. POST the current briefing to /api/mcp/capture-demo (feed parity:
 *      real current/prior + the agent's business impact + the trace).
 *   2. Run each insight's investigation against /api/agent — sequential
 *      because the MCP server is rate-limited (~1 req/s); cached ones
 *      replay fast.
 *   3. Re-POST to bundle the now-cached investigations.
 *
 * Verification harness:
 *   test/api/agent.integration.test.ts pins the /api/agent NDJSON event
 *   contract that runInvestigation drains.
 *   test/api/briefing.integration.test.ts pins that the snapshot written
 *   here is replayed by the ?demo=cached path.
 *
 * The button is gated on `NODE_ENV !== 'production' && !isDemo` at the
 * call site (app/page.tsx); the hook itself is environment-agnostic.
 */

/** Mirrors BriefingResponse['workspace'] in app/page.tsx — kept local so
 *  the hook doesn't import the page module. The cached snapshot the
 *  server writes uses these same optional fields. */
interface CaptureWorkspace {
  projectName?: string;
  totalCustomers?: number;
}

export interface UseDemoCaptureResult {
  capturing: { active: boolean; msg: string };
  captureAll: () => Promise<void>;
}

export function useDemoCapture(
  insights: Insight[],
  workspace: CaptureWorkspace | undefined,
  traceItems: TraceItem[],
): UseDemoCaptureResult {
  // dev-only single-click demo capture progress (briefing → investigations → bundle)
  const [capturing, setCapturing] = useState<{ active: boolean; msg: string }>({
    active: false,
    msg: '',
  });

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
    let result: { ok: boolean; error?: string } = { ok: false, error: 'stream ended without done' };
    await readNdjson<{ type?: string; message?: string }>(res.body, (evt) => {
      if (evt.type === 'done') result = { ok: true };
      else if (evt.type === 'error') result = { ok: false, error: String(evt.message ?? 'error') };
    });
    return result;
  }

  const captureAll = useCallback(async () => {
    if (capturing.active) return;
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
        if (!r.ok && r.error && isAuthErrorAuto(r.error)) {
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
    // postCapture / runInvestigation are closures over insights/workspace/
    // traceItems; rebinding captureAll when those change keeps the captured
    // body in sync with the latest UI state. capturing.active is read inside.
  }, [capturing.active, insights, workspace, traceItems]);

  return { capturing, captureAll };
}
