import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { connectMcp } from '@/lib/mcp/connect';
import { redactSecrets } from '@/lib/mcp/transport';
import { bootstrapSchema } from '@/lib/mcp/schema';
import { DiagnosticAgent } from '@/lib/agents/diagnostic';
import { RecommendationAgent } from '@/lib/agents/recommendation';
import { QueryAgent } from '@/lib/agents/query';
import { classifyIntent } from '@/lib/agents/intent';
import type { McpToolDef } from '@/lib/agents/tool-schemas';
import { getAnomaly, getInsight } from '@/lib/state/insights';
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

function insightToAnomaly(i: Insight): Anomaly {
  return { metric: i.metric, scope: i.scope, change: i.change, severity: i.severity, evidence: [] };
}

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

/** Walk an error's `cause` chain into one string. `console.error(e)` formats
 *  nested causes via Node's util.inspect, but plain `String(e)` does not — so
 *  we assemble the chain ourselves before redacting, otherwise a token nested
 *  inside `e.cause.cause` would survive the redaction and reach Vercel logs. */
function formatError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < 5) {
    if (cur instanceof Error) {
      parts.push(cur.stack ?? cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      cur = null;
    }
    depth++;
  }
  return parts.join('\n  caused by: ');
}

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

  // Wrapped so a setup throw (e.g. missing AUTH_SECRET breaking cookie
  // encryption in production) returns the real message instead of a bare 500.
  let conn: Awaited<ReturnType<typeof connectMcp>>;
  try {
    conn = await connectMcp(sid);
  } catch (e) {
    console.error('[agent] setup error:', redactSecrets(formatError(e)));
    return NextResponse.json(
      { error: `/api/agent setup · ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  if (!conn.ok) return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });

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
      try {
        // Bootstrap INSIDE the stream so the client sees progress immediately
        // (instead of a silent wait while we connect + read the schema).
        const leadAgent: AgentName =
          q && !insightId ? 'coordinator' : step === 'recommend' ? 'recommendation' : 'diagnostic';
        stepFor(leadAgent, 'thought', 'reading the workspace schema…');
        const schema = await bootstrapSchema(conn.mcp);
        const rawTools = await conn.mcp.listTools();
        const allTools: McpToolDef[] = Array.isArray((rawTools as { tools?: unknown })?.tools)
          ? (rawTools as { tools: McpToolDef[] }).tools
          : [];
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        // Free-form query flow (live; never cached) — runs when only `q` is provided.
        if (q && !insightId) {
          const intent = await classifyIntent(anthropic, q);
          stepFor('coordinator', 'thought', `interpreting your question as a ${intent} query…`);
          const queryAgent = new QueryAgent(anthropic, conn.mcp, schema, allTools);
          const answer = await queryAgent.answer(q, intent, hooksFor('coordinator'));
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
          stepFor(
            'diagnostic',
            'thought',
            `investigating "${inv.metric}" (${inv.change.direction} ${inv.change.value}% vs ${inv.change.baseline})…`,
          );
          const diagAgent = new DiagnosticAgent(anthropic, conn.mcp, schema, allTools);
          diagnosis = await diagAgent.investigate(inv, hooksFor('diagnostic'));
          send({ type: 'diagnosis', diagnosis });
        }

        // STEP 3 (recommend) or the combined run: run the recommendation agent.
        // Skipped on the diagnose step — the decision is NOT run until step 3.
        if (step !== 'diagnose') {
          stepFor('recommendation', 'thought', 'proposing actions based on the diagnosis…');
          const recAgent = new RecommendationAgent(anthropic, conn.mcp, schema, allTools);
          const recommendations = await recAgent.propose(inv, diagnosis!, hooksFor('recommendation'));
          for (const r of recommendations) send({ type: 'recommendation', recommendation: r });
        }

        send({ type: 'done' });
        // Only the combined run (capture) is cached to disk; the split steps are
        // handed off via the client's sessionStorage.
        if (step == null) saveInvestigation(insightId!, collected);
      } catch (e) {
        // full stack/cause in Vercel logs, with bearer/OAuth tokens redacted
        console.error('[agent] error:', redactSecrets(formatError(e)));
        send({
          type: 'error',
          message: `/api/agent · ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: NDJSON_HEADERS });
}
