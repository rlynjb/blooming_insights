import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { connectMcp } from '@/lib/mcp/connect';

// DEV-ONLY: captures the bootstrap tool responses to test/fixtures/<tool>.json so
// the Phase 2 schema parser can be built/tested against real response shapes, and
// the demo-cache (?demo=cached) has data to replay. Writes to the repo working
// tree, so it is disabled outside development (serverless filesystems are read-only).
const BOOTSTRAP_TOOLS = [
  'get_project_overview',
  'get_event_schema',
  'get_customer_property_schema',
  'get_customer_schema',
  'list_catalogs',
  'list_dashboards',
  'list_funnels',
  'list_segmentations',
] as const;

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'capture is dev-only' }, { status: 403 });
  }
  try {
    const projectId = req.nextUrl.searchParams.get('project_id');
    if (!projectId) {
      return NextResponse.json({ error: 'project_id query param required' }, { status: 400 });
    }
    const sid = await getOrCreateSessionId();
    const conn = await connectMcp(sid);
    if (!conn.ok) {
      return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });
    }

    const dir = join(process.cwd(), 'test', 'fixtures');
    await mkdir(dir, { recursive: true });

    const captured: Record<string, string> = {};
    for (const name of BOOTSTRAP_TOOLS) {
      try {
        const r = await conn.mcp.callTool(name, { project_id: projectId }, { skipCache: true });
        await writeFile(join(dir, `${name}.json`), JSON.stringify(r.result, null, 2));
        captured[name] = 'ok';
      } catch (e) {
        captured[name] = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return NextResponse.json({ captured, dir });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) },
      { status: 500 },
    );
  }
}
