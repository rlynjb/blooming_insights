import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { connectMcp } from '@/lib/mcp/connect';

export async function POST(req: NextRequest) {
  try {
    const { name, args } = await req.json();
    const sid = await getOrCreateSessionId(); // ensures bi_session cookie is set before auth
    const conn = await connectMcp(sid);
    if (!conn.ok) {
      return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });
    }
    const r = await conn.mcp.callTool(name, args ?? {}, { skipCache: true });
    return NextResponse.json({ result: r.result, durationMs: r.durationMs });
  } catch (e) {
    // Surface the real error as JSON so the client never sees an empty body.
    return NextResponse.json(
      { error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) },
      { status: 500 },
    );
  }
}
