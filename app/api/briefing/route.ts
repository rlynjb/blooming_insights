import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { connectMcp } from '@/lib/mcp/connect';
import { bootstrapSchema } from '@/lib/mcp/schema';
import { MonitoringAgent } from '@/lib/agents/monitoring';
import type { McpToolDef } from '@/lib/agents/tool-schemas';
import { anomalyToInsight, putInsights, listInsights } from '@/lib/state/insights';
import type { ToolCall } from '@/lib/mcp/types';
import type { AgentEvent } from '@/lib/mcp/events';

// 300s = Vercel Pro's max. The monitoring agent + ~1 req/s MCP spacing can run
// well past Hobby's 60s ceiling, so the live briefing needs the higher budget.
export const maxDuration = 300;

const DEMO_FILE = join(process.cwd(), 'lib/state/demo-insights.json');

type BriefingWorkspace = { projectName: string; totalCustomers: number; totalEvents: number };
// Reuse the AgentEvent variants for live activity; add a briefing-only
// `workspace` event for the header. Kept local so the shared AgentEvent
// contract (used by /api/agent + the investigation view) is untouched.
type BriefingEvent = AgentEvent | { type: 'workspace'; workspace: BriefingWorkspace };

/** Human-readable label for a monitoring tool call — prefers the real EQL/query
 *  text the agent actually ran, falling back to the tool name. */
function describeToolCall(tc: ToolCall): string {
  const a = tc.args as Record<string, unknown> | undefined;
  const q = a && (a.eql ?? a.query ?? a.analysis ?? a.expression);
  const text = typeof q === 'string' && q.trim() ? q.trim() : tc.toolName;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

const TRUNC = 4000;
function trunc(v: unknown): unknown {
  const s = JSON.stringify(v);
  return s && s.length > TRUNC ? s.slice(0, TRUNC) + '…' : v;
}

export async function GET(req: NextRequest) {
  const demo = req.nextUrl.searchParams.get('demo') === 'cached';

  // Demo mode: serve the pre-captured snapshot as plain JSON (creds-free).
  if (demo && existsSync(DEMO_FILE)) {
    try {
      const snapshot = JSON.parse(readFileSync(DEMO_FILE, 'utf8'));
      return NextResponse.json({ ...snapshot, demo: true });
    } catch {
      /* fall through to live */
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set' }, { status: 500 });
  }

  // Connect (and surface auth) BEFORE committing to a stream, so we can still
  // return a 401 JSON the feed redirects on. Wrapped so a setup throw (e.g. a
  // missing AUTH_SECRET breaking cookie encryption in production) returns the
  // real message instead of a bare 500.
  let conn: Awaited<ReturnType<typeof connectMcp>>;
  try {
    const sid = await getOrCreateSessionId();
    conn = await connectMcp(sid);
  } catch (e) {
    console.error('[briefing] setup error:', e);
    return NextResponse.json(
      { error: `/api/briefing setup · ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  if (!conn.ok) {
    return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });
  }
  const mcp = conn.mcp;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: BriefingEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      const step = (content: string) =>
        send({
          type: 'reasoning_step',
          step: { id: crypto.randomUUID(), agent: 'monitoring', kind: 'thought', content },
        });
      try {
        step('reading the workspace schema…');
        const schema = await bootstrapSchema(mcp);
        send({
          type: 'workspace',
          workspace: {
            projectName: schema.projectName,
            totalCustomers: schema.totalCustomers,
            totalEvents: schema.totalEvents,
          },
        });

        const raw = await mcp.listTools();
        const allTools: McpToolDef[] = Array.isArray((raw as { tools?: unknown })?.tools)
          ? (raw as { tools: McpToolDef[] }).tools
          : [];

        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const agent = new MonitoringAgent(anthropic, mcp, schema, allTools);

        step('scanning the workspace for significant recent changes…');
        const anomalies = await agent.scan({
          onToolCall: (tc) => {
            send({ type: 'tool_call_start', toolName: tc.toolName, agent: 'monitoring' });
            step(describeToolCall(tc)); // the real query, as the live status line
          },
          onToolResult: (tc) =>
            send({
              type: 'tool_call_end',
              toolName: tc.toolName,
              agent: 'monitoring',
              durationMs: tc.durationMs ?? 0,
              result: trunc(tc.result), // surfaced in the feed's "how it was gathered" trace
              error: tc.error,
            }),
          onText: (t) => {
            if (t.trim()) step(t.trim());
          },
        });

        const insights = anomalies.map(anomalyToInsight);
        putInsights(insights, anomalies);
        for (const insight of listInsights()) send({ type: 'insight', insight });

        send({ type: 'done' });
      } catch (e) {
        console.error('[briefing] error:', e); // full stack/cause in Vercel logs
        send({
          type: 'error',
          message: `/api/briefing · ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
    },
  });
}
