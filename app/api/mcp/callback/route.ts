import { NextRequest, NextResponse } from 'next/server';
import { readSessionId } from '@/lib/mcp/session';
import { completeAuth } from '@/lib/mcp/connect';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (!code) return NextResponse.json({ error: 'missing code' }, { status: 400 });
  const sid = await readSessionId();
  if (!sid) return NextResponse.json({ error: 'no session' }, { status: 400 });
  try {
    await completeAuth(sid, code);
    return NextResponse.redirect(new URL('/debug', req.url));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 401 });
  }
}
