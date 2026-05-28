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

function summarizeTrace(trace: ToolCall[]) {
  return trace.map((t) => ({
    tool: t.toolName,
    args: t.args,
    ok: !t.error,
    error: t.error,
    resultPreview: t.result ? JSON.stringify(t.result).slice(0, 300) : undefined,
  }));
}

export const maxDuration = 60; // agents + ~1 req/s MCP can take a while

const DEMO_FILE = join(process.cwd(), 'lib/state/demo-insights.json');

export async function GET(req: NextRequest) {
  const demo = req.nextUrl.searchParams.get('demo') === 'cached';

  // Demo mode: serve a pre-captured insights snapshot if present (resilience for live demos).
  if (demo && existsSync(DEMO_FILE)) {
    try {
      const snapshot = JSON.parse(readFileSync(DEMO_FILE, 'utf8'));
      return NextResponse.json({ ...snapshot, demo: true });
    } catch { /* fall through to live */ }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set' }, { status: 500 });
  }

  const trace: ToolCall[] = [];
  try {
    const sid = await getOrCreateSessionId();
    const conn = await connectMcp(sid);
    if (!conn.ok) {
      return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });
    }

    const schema = await bootstrapSchema(conn.mcp);

    // tool list for filterToolSchemas
    const raw = await conn.mcp.listTools();
    const allTools: McpToolDef[] = Array.isArray((raw as any)?.tools) ? (raw as any).tools : [];

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const agent = new MonitoringAgent(anthropic, conn.mcp, schema, allTools);
    const anomalies = await agent.scan((tc) => trace.push(tc));

    const insights = anomalies.map(anomalyToInsight);
    putInsights(insights, anomalies);

    return NextResponse.json({
      insights: listInsights(),
      workspace: { projectName: schema.projectName, totalCustomers: schema.totalCustomers, totalEvents: schema.totalEvents },
      trace: summarizeTrace(trace), // diagnostic: which tools the agent called
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e),
        trace: summarizeTrace(trace),
      },
      { status: 500 },
    );
  }
}
