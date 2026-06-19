import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { makeDataSource, type LiveMode } from '@/lib/data-source';
import { redactSecrets, formatError } from '@/lib/mcp/transport';
// `bootstrapSchema` is now consumed indirectly via the DataSource factory's
// `bootstrap()` — see lib/data-source/index.ts.
import { DiagnosticAgent } from '@/lib/agents/diagnostic';
import { RecommendationAgent } from '@/lib/agents/recommendation';
import { QueryAgent } from '@/lib/agents/query';
import { classifyIntent } from '@/lib/agents/intent';
import type { McpToolDef } from '@/lib/agents/tool-schemas';
import { getAnomaly, getInsight, insightToAnomaly } from '@/lib/state/insights';
import { getCachedInvestigation, saveInvestigation } from '@/lib/state/investigations';
import { encodeEvent, type AgentEvent } from '@/lib/mcp/events';
import type { AgentName, Anomaly, Diagnosis, Insight, ToolCall } from '@/lib/mcp/types';

// 300s = Vercel Pro's max. A live investigation (diagnostic → recommendation)
// runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it.
export const maxDuration = 300;

const DEMO_FILE = join(process.cwd(), 'lib/state/demo-insights.json');

// Which part of an investigation to run/replay. The investigate page runs these
// as two steps (diagnose on step 2, recommend on step 3); a null step is the
// legacy combined run used by the demo-snapshot capture.
type Step = 'diagnose' | 'recommend';

/** Resolve the anomaly to investigate. Prefers the client-provided insight
 *  (handed from the feed via sessionStorage → `?insight=`), which is the only
 *  source that survives Vercel's per-instance memory. Falls back to in-memory
 *  (same-instance / dev, scoped to the caller's session) then the demo snapshot. */
function resolveAnomaly(sessionId: string, insightId: string, insightParam?: string | null): Anomaly | null {
  if (insightParam) {
    try {
      const i = JSON.parse(insightParam) as Insight;
      if (i && typeof i.metric === 'string' && i.change && Array.isArray(i.scope) && i.severity) {
        return insightToAnomaly(i);
      }
    } catch {
      /* malformed param — fall through to the server-side lookup */
    }
  }
  const a = getAnomaly(sessionId, insightId);
  if (a) return a;
  const i = getInsight(sessionId, insightId);
  if (i) return insightToAnomaly(i);
  try {
    if (existsSync(DEMO_FILE)) {
      const snap = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as { insights?: Insight[] };
      const di = (snap.insights ?? []).find((x) => x.id === insightId);
      if (di) return insightToAnomaly(di);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Keep only the events belonging to one step, for cached (demo) replay — the
 *  snapshot is a combined diagnose+recommend stream. */
function filterByStep(events: AgentEvent[], step: Step): AgentEvent[] {
  return events.filter((e) => {
    const agent =
      e.type === 'reasoning_step'
        ? e.step.agent
        : e.type === 'tool_call_start' || e.type === 'tool_call_end'
          ? e.agent
          : null;
    if (step === 'diagnose') {
      if (e.type === 'recommendation') return false;
      if (agent === 'recommendation') return false;
      return true; // diagnostic/coordinator reasoning + tools, diagnosis, done
    }
    // recommend: only recommendation-phase activity + recommendations + done
    if (e.type === 'diagnosis') return false;
    if (agent && agent !== 'recommendation') return false;
    return true;
  });
}

function parseDiagnosis(param: string | null): Diagnosis | null {
  if (!param) return null;
  try {
    const d = JSON.parse(param);
    if (d && typeof d.conclusion === 'string' && Array.isArray(d.evidence) && Array.isArray(d.hypothesesConsidered)) {
      return d as Diagnosis;
    }
  } catch {
    /* ignore */
  }
  return null;
}

const TRUNC = 4000;
const trunc = (v: unknown): unknown => {
  const s = JSON.stringify(v);
  return s && s.length > TRUNC ? s.slice(0, TRUNC) + '…' : v;
};

const REPLAY_DELAY_MS = 180;

const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
};

export async function GET(req: NextRequest) {
  const insightId = req.nextUrl.searchParams.get('insightId');
  const insightParam = req.nextUrl.searchParams.get('insight');
  const q = req.nextUrl.searchParams.get('q')?.trim() || null;
  const live = req.nextUrl.searchParams.get('live') === '1';
  const stepParam = req.nextUrl.searchParams.get('step');
  const step: Step | null = stepParam === 'diagnose' || stepParam === 'recommend' ? stepParam : null;
  const diagnosisParam = req.nextUrl.searchParams.get('diagnosis');

  if (!insightId && !q) {
    return NextResponse.json({ error: 'insightId or q required' }, { status: 400 });
  }

  // Cache-first: replay a precomputed investigation (no auth/key needed),
  // filtered to the requested step. Query results are never cached.
  const cached = insightId && !live ? getCachedInvestigation(insightId) : null;
  if (cached) {
    const events = step ? filterByStep(cached, step) : cached;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const e of events) {
          // Client cancelled mid-replay — break out so we don't keep enqueuing
          // bytes into an already-closed reader.
          if (req.signal.aborted) break;
          controller.enqueue(encoder.encode(encodeEvent(e)));
          await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: NDJSON_HEADERS });
  }

  // For the investigation flow we need a resolvable anomaly; the query flow does not.
  // The lookup is scoped to the caller's session so concurrent users can't read
  // each other's anomalies — the cookie also drives the MCP auth path below.
  const sid = await getOrCreateSessionId();
  const anomaly = insightId ? resolveAnomaly(sid, insightId, insightParam) : null;
  if (insightId && !anomaly) {
    return NextResponse.json({ error: 'insight not found' }, { status: 404 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set' }, { status: 500 });
  }

  // The factory now only constructs the Bloomreach adapter; the legacy
  // `?mode=` param is accepted but ignored (the previously-supported
  // `'live-sql'` Olist adapter has been removed).
  const mode: LiveMode = 'live-bloomreach';

  // Construct the DataSource via the factory. Wrapped so a setup throw (e.g.
  // missing AUTH_SECRET breaking cookie encryption in production) returns the
  // real message instead of a bare 500.
  let dsResult: Awaited<ReturnType<typeof makeDataSource>>;
  try {
    dsResult = await makeDataSource(mode, sid);
  } catch (e) {
    console.error('[agent] setup error:', redactSecrets(formatError(e)));
    return NextResponse.json(
      { error: `/api/agent setup · ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  if (!dsResult.ok) return NextResponse.json({ needsAuth: true, authUrl: dsResult.authUrl }, { status: 401 });
  // The abstract DataSource surface is what agents + bootstrapSchema consume.
  // The 4 short MCP routes still use the Bloomreach adapter directly for the
  // skipCache option (cache-bypass is Bloomreach-specific).
  const dataSource = dsResult.dataSource;
  const bootstrap = dsResult.bootstrap;
  const disposeDataSource = dsResult.dispose;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const collected: AgentEvent[] = [];
      const send = (e: AgentEvent) => {
        collected.push(e);
        controller.enqueue(encoder.encode(encodeEvent(e)));
      };
      const stepFor = (
        agent: AgentName,
        kind: 'thought' | 'hypothesis' | 'conclusion',
        content: string,
      ) => send({ type: 'reasoning_step', step: { id: crypto.randomUUID(), agent, kind, content } });
      const hooksFor = (agent: AgentName) => ({
        onText: (t: string) => {
          if (t.trim()) stepFor(agent, 'thought', t);
        },
        onToolCall: (tc: ToolCall) => send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
        onToolResult: (tc: ToolCall) =>
          send({
            type: 'tool_call_end',
            toolName: tc.toolName,
            agent,
            durationMs: tc.durationMs ?? 0,
            result: trunc(tc.result),
            error: tc.error,
          }),
      });
      // Per-phase wall-clock timings — server-side `console.log` only, emitted
      // once per request in the `finally` so the summary still fires when a
      // phase throws (the 300s-budget incident signal). Not on the NDJSON wire.
      // Shape matches /api/briefing so a single Vercel filter reads both routes.
      const t0 = performance.now();
      const phases: Array<{ phase: string; durationMs: number }> = [];
      const recordPhase = (phase: string, started: number) => {
        phases.push({ phase, durationMs: Math.round(performance.now() - started) });
      };
      try {
        // Cancellation is honored at coarse phase boundaries inside the stream
        // AND threaded into every async layer below (bootstrapSchema, listTools,
        // classifyIntent + the four agent classes → runAgentLoop → dataSource.callTool
        // + anthropic.messages.create). The per-call 30s MCP transport timeout
        // still bounds any single call.
        req.signal.throwIfAborted();
        // Bootstrap INSIDE the stream so the client sees progress immediately
        // (instead of a silent wait while we connect + read the schema).
        const leadAgent: AgentName =
          q && !insightId ? 'coordinator' : step === 'recommend' ? 'recommendation' : 'diagnostic';
        stepFor(leadAgent, 'thought', 'reading the workspace schema…');
        const t_schema = performance.now();
        // The factory's bootstrap runs the Bloomreach orchestrator
        // (list_cloud_organizations / get_event_schema / …).
        const schema = await bootstrap(req.signal);
        recordPhase('schema_bootstrap', t_schema);
        req.signal.throwIfAborted();
        const t_listTools = performance.now();
        const rawTools = await dataSource.listTools({ signal: req.signal });
        const allTools: McpToolDef[] = Array.isArray((rawTools as { tools?: unknown })?.tools)
          ? (rawTools as { tools: McpToolDef[] }).tools
          : [];
        recordPhase('list_tools', t_listTools);
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        // Free-form query flow (live; never cached) — runs when only `q` is provided.
        if (q && !insightId) {
          req.signal.throwIfAborted();
          const t_intent = performance.now();
          const intent = await classifyIntent(anthropic, q, sid, req.signal);
          recordPhase('intent_classify', t_intent);
          stepFor('coordinator', 'thought', `interpreting your question as a ${intent} query…`);
          const queryAgent = new QueryAgent(anthropic, dataSource, schema, allTools, sid);
          const t_query = performance.now();
          const answer = await queryAgent.answer(q, intent, { ...hooksFor('coordinator'), signal: req.signal });
          recordPhase('query_answer', t_query);
          stepFor('coordinator', 'conclusion', answer);
          send({ type: 'done' });
          return;
        }

        // Investigation flow — `anomaly` is guaranteed present here.
        const inv = anomaly!;
        let diagnosis: Diagnosis | null = null;

        // STEP 2 (diagnose) or the combined run: run the diagnostic agent.
        if (step === 'recommend') {
          // STEP 3: the diagnosis was handed over from step 2.
          diagnosis = parseDiagnosis(diagnosisParam);
          if (!diagnosis) {
            throw new Error('no diagnosis was handed over — open the diagnosis step first');
          }
        } else {
          req.signal.throwIfAborted();
          stepFor(
            'diagnostic',
            'thought',
            `investigating "${inv.metric}" (${inv.change.direction} ${inv.change.value}% vs ${inv.change.baseline})…`,
          );
          const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
          const t_diag = performance.now();
          diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
          recordPhase('diagnostic_investigate', t_diag);
          send({ type: 'diagnosis', diagnosis });
        }

        // STEP 3 (recommend) or the combined run: run the recommendation agent.
        // Skipped on the diagnose step — the decision is NOT run until step 3.
        if (step !== 'diagnose') {
          req.signal.throwIfAborted();
          stepFor('recommendation', 'thought', 'proposing actions based on the diagnosis…');
          const recAgent = new RecommendationAgent(anthropic, dataSource, schema, allTools, sid);
          const t_rec = performance.now();
          const recommendations = await recAgent.propose(inv, diagnosis!, { ...hooksFor('recommendation'), signal: req.signal });
          recordPhase('recommendation_propose', t_rec);
          for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
        }

        send({ type: 'done' });
        // Only the combined run (capture) is cached to disk; the split steps are
        // handed off via the client's sessionStorage.
        if (step == null) saveInvestigation(insightId!, collected);
      } catch (e) {
        // Client cancelled (closed tab / navigated away / unmount cleanup) —
        // skip the error event (no consumer to read it) but still let the
        // finally fire so the phase log records how much budget was burned
        // before the cancel landed.
        if (e instanceof DOMException && e.name === 'AbortError') {
          return;
        }
        // full stack/cause in Vercel logs, with bearer/OAuth tokens redacted
        console.error('[agent] error:', redactSecrets(formatError(e)));
        send({
          type: 'error',
          message: `/api/agent · ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        // Tear the per-request DataSource down. Currently a no-op for the
        // Bloomreach adapter (the OAuth client outlives the request via the
        // cookie store). Best-effort — a teardown error must NOT swallow the
        // route-level error above.
        try {
          await disposeDataSource();
        } catch (disposeErr) {
          console.error('[agent] dispose error:', redactSecrets(formatError(disposeErr)));
        }
        // One summary line per request — shared shape with /api/briefing so a
        // single Vercel filter (e.g. phases.phase = "schema_bootstrap") reads
        // across both routes. Fires even on error so we can see how much of the
        // 300s budget was burned before the failure.
        console.log(JSON.stringify({
          route: '/api/agent',
          sessionId: sid,
          mode,
          totalMs: Math.round(performance.now() - t0),
          phases,
          aborted: req.signal.aborted,
        }));
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: NDJSON_HEADERS });
}
