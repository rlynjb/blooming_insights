import { NextRequest, NextResponse } from 'next/server';
import { readSessionId } from '@/lib/mcp/session';
import { consumeState } from '@/lib/mcp/auth';
import { completeAuth } from '@/lib/mcp/connect';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  // The IdP signals a denial/failure via ?error=...&error_description=...
  const oauthError = params.get('error');
  if (oauthError) {
    return NextResponse.json(
      { error: oauthError, description: params.get('error_description') },
      { status: 401 },
    );
  }

  const code = params.get('code');
  if (!code) return NextResponse.json({ error: 'missing code' }, { status: 400 });
  const sid = await readSessionId();
  if (!sid) return NextResponse.json({ error: 'no session' }, { status: 400 });

  // CSRF: validate the state param against the value stored for this session.
  if (!consumeState(sid, params.get('state'))) {
    return NextResponse.json({ error: 'state mismatch' }, { status: 401 });
  }

  try {
    await completeAuth(sid, code);
    return NextResponse.redirect(new URL('/debug', req.url));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 401 });
  }
}
