import { NextRequest, NextResponse } from 'next/server';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// DEV-ONLY: write the current LIVE briefing (insights + workspace + gathering
// trace) sent from the feed as the demo snapshot, so demo mode replays it with
// per-item provenance and the "how it was gathered" trace. Serverless
// filesystems are read-only, so this is disabled in production — capture locally
// then commit lib/state/demo-insights.json.
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'capture is dev-only' }, { status: 403 });
  }
  try {
    const body = (await req.json()) as {
      insights?: unknown;
      workspace?: unknown;
      trace?: unknown;
    };
    if (!Array.isArray(body?.insights) || body.insights.length === 0) {
      return NextResponse.json(
        { error: 'body.insights[] required (run a live briefing first)' },
        { status: 400 },
      );
    }
    const insights = body.insights;
    const snapshot = {
      insights,
      workspace: body.workspace ?? {},
      trace: Array.isArray(body.trace) ? body.trace : [],
    };
    await writeFile(
      join(process.cwd(), 'lib/state/demo-insights.json'),
      JSON.stringify(snapshot, null, 2),
    );

    // Bundle the investigations already run this session (cached in dev to
    // .investigation-cache.json), keyed by the SAME insight ids — otherwise the
    // re-captured insights get new ids and demo replay can't find them.
    const ids = new Set(
      insights.map((i) => (i as { id?: string })?.id).filter((x): x is string => !!x),
    );
    let captured = 0;
    const cacheFile = join(process.cwd(), '.investigation-cache.json');
    if (existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, unknown>;
        const filtered: Record<string, unknown> = {};
        for (const [id, events] of Object.entries(cache)) {
          if (ids.has(id)) {
            filtered[id] = events;
            captured++;
          }
        }
        if (captured > 0) {
          await writeFile(
            join(process.cwd(), 'lib/state/demo-investigations.json'),
            JSON.stringify(filtered, null, 2),
          );
        }
      } catch {
        /* leave demo-investigations.json untouched on a bad cache */
      }
    }

    return NextResponse.json({
      ok: true,
      insights: insights.length,
      investigations: captured,
      traceItems: snapshot.trace.length,
      note:
        captured < insights.length
          ? `${captured}/${insights.length} investigations cached — open the rest live, then capture again so every demo card replays.`
          : 'all insights have a cached investigation.',
      files: [
        'lib/state/demo-insights.json',
        ...(captured > 0 ? ['lib/state/demo-investigations.json'] : []),
      ],
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
