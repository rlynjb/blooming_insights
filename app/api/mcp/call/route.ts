import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { connectMcp } from '@/lib/mcp/connect';
import { redactSecrets, formatError } from '@/lib/mcp/transport';
import {
  monitoringTools,
  diagnosticTools,
  recommendationTools,
  bootstrapTools,
} from '@/lib/mcp/tools';

// Allowlist of tool names this app intends to call. Built once per warm
// instance. Sourced from the same constants the agents use, so the boundary
// stays in sync with what the rest of the system already speaks.
const ALL_KNOWN = new Set<string>([
  ...monitoringTools,
  ...diagnosticTools,
  ...recommendationTools,
  ...bootstrapTools,
]);

export async function POST(req: NextRequest) {
  try {
    const { name, args } = await req.json();
    if (typeof name !== 'string' || !ALL_KNOWN.has(name)) {
      return NextResponse.json({ error: 'tool not allowed' }, { status: 403 });
    }
    const sid = await getOrCreateSessionId(); // ensures bi_session cookie is set before auth
    const conn = await connectMcp(sid);
    if (!conn.ok) {
      return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });
    }
    const r = await conn.mcp.callTool(name, args ?? {}, { skipCache: true });
    return NextResponse.json({ result: r.result, durationMs: r.durationMs });
  } catch (e) {
    // Surface the real error as JSON so the client never sees an empty body.
    console.error('[mcp-call] error:', redactSecrets(formatError(e)));
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
