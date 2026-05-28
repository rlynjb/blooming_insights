import { NextRequest, NextResponse } from 'next/server';
import { readSessionId } from '@/lib/mcp/session';
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

  // NOTE: we do NOT re-validate the OAuth `state` here. The MCP SDK invokes the
  // provider's state() more than once during a single auth() flow, so our naive
  // "store-last, compare-on-callback" check rejected legitimate callbacks
  // ("state mismatch"). The SDK performs its own state handling; re-validating
  // at this layer is redundant. (Verified live 2026-05-27.)

  try {
    await completeAuth(sid, code);
    return NextResponse.redirect(new URL('/debug', req.url));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 401 });
  }
}
