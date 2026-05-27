import { describe, it, expect } from 'vitest';
import { putSession, getSession, _clearAllSessions } from '../../lib/mcp/auth';

describe('session store', () => {
  it('stores and retrieves a live session', async () => {
    _clearAllSessions();
    putSession('sid-1', { token: 't', expiresAt: Date.now() + 10_000 });
    const s = await getSession('sid-1');
    expect(s?.token).toBe('t');
  });

  it('returns null for an expired session', async () => {
    _clearAllSessions();
    putSession('sid-2', { token: 't', expiresAt: Date.now() - 1 });
    expect(await getSession('sid-2')).toBeNull();
  });

  it('returns null for an unknown session', async () => {
    _clearAllSessions();
    expect(await getSession('nope')).toBeNull();
  });
});
