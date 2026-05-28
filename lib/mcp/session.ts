import { cookies } from 'next/headers';

const COOKIE = 'bi_session';

// In production the session cookie has to survive the cross-site OAuth round-trip
// (we redirect to Bloomreach and the IdP redirects back to /api/mcp/callback).
// SameSite=Lax can drop the cookie on that return in some browsers/flows, so use
// SameSite=None + Secure on HTTPS. Locally (http://localhost) Secure cookies
// aren't sent, so fall back to Lax without Secure.
function sessionCookieOpts() {
  return process.env.NODE_ENV === 'production'
    ? { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/' }
    : { httpOnly: true, sameSite: 'lax' as const, path: '/' };
}

export async function getOrCreateSessionId(): Promise<string> {
  const jar = await cookies();
  let id = jar.get(COOKIE)?.value;
  if (!id) {
    id = crypto.randomUUID();
    jar.set(COOKIE, id, sessionCookieOpts());
  }
  return id;
}

export async function readSessionId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE)?.value ?? null;
}
