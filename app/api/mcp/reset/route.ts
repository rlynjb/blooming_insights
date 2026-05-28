import { NextResponse } from 'next/server';
import { getOrCreateSessionId } from '@/lib/mcp/session';
import { clearAuth, deleteAuthCookie } from '@/lib/mcp/auth';

// Clear stored auth for this session so the next request re-runs the OAuth flow.
// Use when the MCP server has rotated/revoked tokens (the "fetch failed" / 401
// invalid_token case). In dev this clears the .auth-cache.json entry; in
// production it deletes the encrypted `bi_auth` cookie. The feed then redirects
// to re-auth on its next request.
export async function POST() {
  const sid = await getOrCreateSessionId();
  clearAuth(sid); // dev/test: removes the file/memory entry (no-op in prod)
  await deleteAuthCookie(); // production: drops the encrypted cookie (no-op in dev/test)
  return NextResponse.json({ ok: true, cleared: true });
}
