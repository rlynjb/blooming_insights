import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { connectMcp } from '@/lib/mcp/connect';
import { bootstrapSchema } from '@/lib/mcp/schema';
import { DiagnosticAgent } from '@/lib/agents/diagnostic';
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
  const agent = new DiagnosticAgent(anthropic, conn.mcp, schema, allTools);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AgentEvent) => controller.enqueue(encoder.encode(encodeEvent(e)));
      const step = (kind: 'thought' | 'hypothesis' | 'conclusion', content: string) =>
        send({ type: 'reasoning_step', step: { id: crypto.randomUUID(), agent: 'diagnostic', kind, content } });
      try {
        step(
          'thought',
          `investigating "${anomaly.metric}" (${anomaly.change.direction} ${anomaly.change.value}% vs ${anomaly.change.baseline})…`,
        );
        const diagnosis = await agent.investigate(anomaly, {
          onText: (t) => {
            if (t.trim()) step('thought', t);
          },
          onToolCall: (tc) => send({ type: 'tool_call_start', toolName: tc.toolName, agent: 'diagnostic' }),
          onToolResult: (tc) =>
            send({
              type: 'tool_call_end',
              toolName: tc.toolName,
              agent: 'diagnostic',
              durationMs: tc.durationMs ?? 0,
              result: trunc(tc.result),
              error: tc.error,
            }),
        });
        send({ type: 'diagnosis', diagnosis });
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
