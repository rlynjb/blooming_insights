import { cookies } from 'next/headers';

const COOKIE = 'bi_session';

export async function getOrCreateSessionId(): Promise<string> {
  const jar = await cookies();
  let id = jar.get(COOKIE)?.value;
  if (!id) {
    id = crypto.randomUUID();
    jar.set(COOKIE, id, { httpOnly: true, sameSite: 'lax', path: '/' });
  }
  return id;
}

export async function readSessionId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE)?.value ?? null;
}
