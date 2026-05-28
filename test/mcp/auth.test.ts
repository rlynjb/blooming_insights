import { describe, it, expect, beforeEach } from 'vitest';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  BloomreachAuthProvider,
  hasTokens,
  clearAuth,
  consumeState,
  _clearAuthStore,
  _authCookieCrypto,
} from '../../lib/mcp/auth';

const REDIRECT = 'http://localhost:3000/api/mcp/callback';
const tokens: OAuthTokens = { access_token: 'tok', token_type: 'Bearer' };

describe('BloomreachAuthProvider', () => {
  beforeEach(() => {
    _clearAuthStore();
  });

  it('round-trips tokens for a session id', () => {
    const p = new BloomreachAuthProvider('sid-1', REDIRECT);
    expect(p.tokens()).toBeUndefined();
    p.saveTokens(tokens);
    expect(p.tokens()).toEqual(tokens);
  });

  it('round-trips the PKCE code verifier and throws when none stored', () => {
    const p = new BloomreachAuthProvider('sid-1', REDIRECT);
    expect(() => p.codeVerifier()).toThrow();
    p.saveCodeVerifier('verifier-123');
    expect(p.codeVerifier()).toBe('verifier-123');
  });

  it('captures the authorize url via redirectToAuthorization', () => {
    const p = new BloomreachAuthProvider('sid-1', REDIRECT);
    expect(p.lastAuthorizeUrl).toBeUndefined();
    const url = new URL('https://example.com/authorize?foo=bar');
    p.redirectToAuthorization(url);
    expect(p.lastAuthorizeUrl?.toString()).toBe(url.toString());
  });

  it('isolates state between two different session ids', () => {
    const a = new BloomreachAuthProvider('sid-a', REDIRECT);
    const b = new BloomreachAuthProvider('sid-b', REDIRECT);
    a.saveTokens(tokens);
    expect(a.tokens()).toEqual(tokens);
    expect(b.tokens()).toBeUndefined();
  });

  it('hasTokens reflects saved tokens and clearAuth removes them', () => {
    const p = new BloomreachAuthProvider('sid-1', REDIRECT);
    expect(hasTokens('sid-1')).toBe(false);
    p.saveTokens(tokens);
    expect(hasTokens('sid-1')).toBe(true);
    clearAuth('sid-1');
    expect(hasTokens('sid-1')).toBe(false);
  });

  it('exposes clientMetadata as a public-client DCR request', () => {
    const p = new BloomreachAuthProvider('sid-1', REDIRECT);
    const md = p.clientMetadata;
    expect(md.token_endpoint_auth_method).toBe('none');
    expect(md.scope).toBe('openid profile email');
    expect(md.redirect_uris).toEqual([REDIRECT]);
    expect(md.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(md.response_types).toEqual(['code']);
  });

  it('exposes redirectUrl from the constructor', () => {
    const p = new BloomreachAuthProvider('sid-1', REDIRECT);
    expect(p.redirectUrl).toBe(REDIRECT);
  });

  it('state() returns a value and persists it for the session', () => {
    const p = new BloomreachAuthProvider('sid-1', REDIRECT);
    const s = p.state();
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });
});

describe('consumeState (CSRF)', () => {
  beforeEach(() => {
    _clearAuthStore();
  });

  it('accepts a matching state and rejects a mismatch', () => {
    const p = new BloomreachAuthProvider('sid-1', REDIRECT);
    const s = p.state();
    expect(consumeState('sid-1', 'wrong')).toBe(false);
  });

  it('accepts the exact state the provider generated', () => {
    const p = new BloomreachAuthProvider('sid-1', REDIRECT);
    const s = p.state();
    expect(consumeState('sid-1', s)).toBe(true);
  });

  it('is one-time use: the stored state is cleared after a check', () => {
    const p = new BloomreachAuthProvider('sid-1', REDIRECT);
    const s = p.state();
    expect(consumeState('sid-1', s)).toBe(true);
    // stored state is now cleared, so a replay can no longer be matched against it
    expect(consumeState('sid-1', s)).toBe(true); // falls through to the no-stored-state path
  });

  it('returns true (cannot enforce) when no state was stored', () => {
    expect(consumeState('unknown-sid', 'whatever')).toBe(true);
  });
});

describe('auth cookie crypto (production backend)', () => {
  it('round-trips an encrypted store under AUTH_SECRET', () => {
    process.env.AUTH_SECRET = 'test-secret-please-ignore';
    const store = { 'sid-1': { tokens, codeVerifier: 'v', state: 's' } };
    const token = _authCookieCrypto.encrypt(store);
    expect(typeof token).toBe('string');
    expect(token).not.toContain('tok'); // ciphertext, not plaintext tokens
    expect(_authCookieCrypto.decrypt(token)).toEqual(store);
  });

  it('returns an empty store for a tampered/garbage cookie', () => {
    process.env.AUTH_SECRET = 'test-secret-please-ignore';
    expect(_authCookieCrypto.decrypt('not-a-valid-token')).toEqual({});
  });
});
