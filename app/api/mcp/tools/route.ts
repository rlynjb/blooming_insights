import { NextResponse } from 'next/server';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { connectMcp } from '@/lib/mcp/connect';
import { redactSecrets, formatError } from '@/lib/mcp/transport';

// Introspection endpoint: returns the tool set the MCP server exposes for the
// current session (name, description, inputSchema). Used by /debug to discover
// each tool's required arguments.
export async function GET() {
  try {
    const sid = await getOrCreateSessionId();
    const conn = await connectMcp(sid);
    if (!conn.ok) {
      return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });
    }
    const tools = await conn.mcp.listTools();
    return NextResponse.json({ tools });
  } catch (e) {
    console.error('[mcp-tools] error:', redactSecrets(formatError(e)));
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
