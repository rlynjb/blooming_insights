import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnonymousAuthProvider,
  BearerAuthProvider,
  makeAuthProvider,
  parseAuthType,
  readAuthEnv,
  type McpAuthType,
} from '@/lib/mcp/auth-providers';

describe('AnonymousAuthProvider', () => {
  it('returns undefined tokens so the SDK sends no Authorization header', () => {
    const p = new AnonymousAuthProvider();
    expect(p.tokens()).toBeUndefined();
  });

  it('client metadata declares no OAuth capabilities', () => {
    const p = new AnonymousAuthProvider();
    expect(p.clientMetadata.grant_types).toEqual([]);
    expect(p.clientMetadata.response_types).toEqual([]);
    expect(p.clientMetadata.redirect_uris).toEqual([]);
    expect(p.clientMetadata.token_endpoint_auth_method).toBe('none');
  });

  it('throws if the SDK tries to enter an OAuth flow', () => {
    const p = new AnonymousAuthProvider();
    expect(() => p.redirectToAuthorization()).toThrow(/redirectToAuthorization called/);
    expect(() => p.codeVerifier()).toThrow(/codeVerifier called/);
  });
});

describe('BearerAuthProvider', () => {
  it('returns the passed token as an OAuthTokens envelope', () => {
    const p = new BearerAuthProvider('abc123');
    expect(p.tokens()).toEqual({ access_token: 'abc123', token_type: 'Bearer' });
  });

  it('rejects an empty token at construction', () => {
    expect(() => new BearerAuthProvider('')).toThrow(/non-empty token/);
  });

  it('throws if the SDK tries to enter an OAuth flow', () => {
    const p = new BearerAuthProvider('tok');
    expect(() => p.redirectToAuthorization()).toThrow(/redirectToAuthorization called/);
    expect(() => p.codeVerifier()).toThrow(/codeVerifier called/);
  });

  it('client metadata declares no OAuth capabilities', () => {
    const p = new BearerAuthProvider('tok');
    expect(p.clientMetadata.grant_types).toEqual([]);
    expect(p.clientMetadata.token_endpoint_auth_method).toBe('none');
  });
});

describe('parseAuthType', () => {
  it.each([
    ['bearer', 'bearer'],
    ['anonymous', 'anonymous'],
    ['oauth-bloomreach', 'oauth-bloomreach'],
    // Anything else → default 'oauth-bloomreach'
    ['unknown', 'oauth-bloomreach'],
    ['', 'oauth-bloomreach'],
    [undefined, 'oauth-bloomreach'],
    [null, 'oauth-bloomreach'],
  ])('%p → %p', (input, expected) => {
    expect(parseAuthType(input as string | null | undefined)).toBe(expected);
  });
});

describe('readAuthEnv', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.MCP_AUTH_TYPE;
    delete process.env.MCP_AUTH_TOKEN;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to oauth-bloomreach when nothing is set', () => {
    expect(readAuthEnv()).toEqual({ type: 'oauth-bloomreach', bearerToken: undefined });
  });

  it('reads bearer + token from env', () => {
    vi.stubEnv('MCP_AUTH_TYPE', 'bearer');
    vi.stubEnv('MCP_AUTH_TOKEN', 'my-token');
    expect(readAuthEnv()).toEqual({ type: 'bearer', bearerToken: 'my-token' });
    vi.unstubAllEnvs();
  });

  it('throws when MCP_AUTH_TYPE=bearer but MCP_AUTH_TOKEN is missing', () => {
    vi.stubEnv('MCP_AUTH_TYPE', 'bearer');
    expect(() => readAuthEnv()).toThrow(/MCP_AUTH_TOKEN/);
    vi.unstubAllEnvs();
  });

  it('anonymous never requires a token', () => {
    vi.stubEnv('MCP_AUTH_TYPE', 'anonymous');
    expect(readAuthEnv()).toEqual({ type: 'anonymous', bearerToken: undefined });
    vi.unstubAllEnvs();
  });
});

describe('makeAuthProvider', () => {
  it('builds an oauth-bloomreach provider given sessionId + redirectUri', () => {
    const p = makeAuthProvider({
      type: 'oauth-bloomreach',
      sessionId: 'sid-1',
      redirectUri: 'https://example.com/cb',
    });
    // BloomreachAuthProvider — smoke-check via one of its known methods
    expect(typeof p.state).toBe('function');
    expect(p.redirectUrl).toBe('https://example.com/cb');
  });

  it('rejects oauth-bloomreach without sessionId or redirectUri', () => {
    expect(() =>
      makeAuthProvider({ type: 'oauth-bloomreach' }),
    ).toThrow(/sessionId \+ redirectUri/);
    expect(() =>
      makeAuthProvider({ type: 'oauth-bloomreach', sessionId: 'x' }),
    ).toThrow(/sessionId \+ redirectUri/);
    expect(() =>
      makeAuthProvider({ type: 'oauth-bloomreach', redirectUri: 'x' }),
    ).toThrow(/sessionId \+ redirectUri/);
  });

  it('builds a bearer provider given bearerToken', () => {
    const p = makeAuthProvider({ type: 'bearer', bearerToken: 'tok' });
    expect(p.tokens()).toEqual({ access_token: 'tok', token_type: 'Bearer' });
  });

  it('rejects bearer without bearerToken', () => {
    expect(() => makeAuthProvider({ type: 'bearer' })).toThrow(/bearerToken/);
  });

  it('builds an anonymous provider with no config', () => {
    const p = makeAuthProvider({ type: 'anonymous' });
    expect(p.tokens()).toBeUndefined();
  });

  it('exhaustively covers all McpAuthType values', () => {
    const all: McpAuthType[] = ['oauth-bloomreach', 'bearer', 'anonymous'];
    for (const type of all) {
      const config =
        type === 'oauth-bloomreach'
          ? { type, sessionId: 'sid', redirectUri: 'https://x/cb' }
          : type === 'bearer'
            ? { type, bearerToken: 'tok' }
            : { type };
      expect(() => makeAuthProvider(config)).not.toThrow();
    }
  });
});
