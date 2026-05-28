import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { connectMcp } from '@/lib/mcp/connect';
import { bootstrapSchema } from '@/lib/mcp/schema';
import { DiagnosticAgent } from '@/lib/agents/diagnostic';
import { RecommendationAgent } from '@/lib/agents/recommendation';
import type { McpToolDef } from '@/lib/agents/tool-schemas';
import { getAnomaly, getInsight } from '@/lib/state/insights';
import { encodeEvent, type AgentEvent } from '@/lib/mcp/events';
import type { Anomaly, Insight } from '@/lib/mcp/types';

export const maxDuration = 60;

const DEMO_FILE = join(process.cwd(), 'lib/state/demo-insights.json');

function insightToAnomaly(i: Insight): Anomaly {
  return { metric: i.metric, scope: i.scope, change: i.change, severity: i.severity, evidence: [] };
}

/** Resolve the anomaly to investigate: in-memory state first, then the demo snapshot. */
function resolveAnomaly(insightId: string): Anomaly | null {
  const a = getAnomaly(insightId);
  if (a) return a;
  const i = getInsight(insightId);
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

const TRUNC = 4000;
const trunc = (v: unknown): unknown => {
  const s = JSON.stringify(v);
  return s && s.length > TRUNC ? s.slice(0, TRUNC) + '…' : v;
};

export async function GET(req: NextRequest) {
  const insightId = req.nextUrl.searchParams.get('insightId');
  if (!insightId) return NextResponse.json({ error: 'insightId required' }, { status: 400 });

  const anomaly = resolveAnomaly(insightId);
  if (!anomaly) return NextResponse.json({ error: 'insight not found' }, { status: 404 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set' }, { status: 500 });
  }

  const sid = await getOrCreateSessionId();
  const conn = await connectMcp(sid);
  if (!conn.ok) return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });

  const schema = await bootstrapSchema(conn.mcp);
  const rawTools = await conn.mcp.listTools();
  const allTools: McpToolDef[] = Array.isArray((rawTools as { tools?: unknown })?.tools)
    ? ((rawTools as { tools: McpToolDef[] }).tools)
    : [];
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AgentEvent) => controller.enqueue(encoder.encode(encodeEvent(e)));
      const stepFor = (
        agent: 'diagnostic' | 'recommendation',
        kind: 'thought' | 'hypothesis' | 'conclusion',
        content: string,
      ) => send({ type: 'reasoning_step', step: { id: crypto.randomUUID(), agent, kind, content } });
      const hooksFor = (agent: 'diagnostic' | 'recommendation') => ({
        onText: (t: string) => {
          if (t.trim()) stepFor(agent, 'thought', t);
        },
        onToolCall: (tc: import('@/lib/mcp/types').ToolCall) =>
          send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
        onToolResult: (tc: import('@/lib/mcp/types').ToolCall) =>
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
        stepFor(
          'diagnostic',
          'thought',
          `investigating "${anomaly.metric}" (${anomaly.change.direction} ${anomaly.change.value}% vs ${anomaly.change.baseline})…`,
        );
        const diagAgent = new DiagnosticAgent(anthropic, conn.mcp, schema, allTools);
        const diagnosis = await diagAgent.investigate(anomaly, hooksFor('diagnostic'));
        send({ type: 'diagnosis', diagnosis });

        stepFor('recommendation', 'thought', 'proposing actions based on the diagnosis…');
        const recAgent = new RecommendationAgent(anthropic, conn.mcp, schema, allTools);
        const recommendations = await recAgent.propose(anomaly, diagnosis, hooksFor('recommendation'));
        for (const r of recommendations) send({ type: 'recommendation', recommendation: r });

        send({ type: 'done' });
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
