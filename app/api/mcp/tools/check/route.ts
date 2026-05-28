import { NextResponse } from 'next/server';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { connectMcp } from '@/lib/mcp/connect';
import { crossCheckToolCoverage, extractToolNames } from '@/lib/mcp/tool-coverage';

// Dev introspection: connects with the current session, dumps the server's
// live tool set, and cross-checks every configured tool name (monitoring /
// diagnostic / recommendation / bootstrap) against it. Any name under
// `missing` is configured but not exposed by the server — handing it to Claude
// wastes a rate-limited call. Open this in the browser like /debug.
export async function GET() {
  try {
    const sid = await getOrCreateSessionId();
    const conn = await connectMcp(sid);
    if (!conn.ok) {
      return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });
    }
    const raw = await conn.mcp.listTools();
    const report = crossCheckToolCoverage(extractToolNames(raw));
    return NextResponse.json(report, { status: report.ok ? 200 : 409 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) },
      { status: 500 },
    );
  }
}
