import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BI_MCP_CONFIG_HEADER,
  BI_MCP_CONFIG_KEY,
  decodeConfigHeader,
  encodeConfigHeader,
  isMcpConfigOverride,
  normalizeConfig,
  persistedConfigHeader,
  readPersistedConfig,
  writePersistedConfig,
} from '@/lib/mcp/config';

describe('constants', () => {
  it('exposes the localStorage key and header name', () => {
    expect(BI_MCP_CONFIG_KEY).toBe('bi:mcp_config');
    expect(BI_MCP_CONFIG_HEADER).toBe('x-bi-mcp-config');
  });
});

describe('isMcpConfigOverride', () => {
  it('accepts the empty object (all fields optional)', () => {
    expect(isMcpConfigOverride({})).toBe(true);
  });

  it('accepts a fully-populated override', () => {
    expect(
      isMcpConfigOverride({
        url: 'https://mcp.example.com/',
        authType: 'bearer',
        bearerToken: 'tok',
      }),
    ).toBe(true);
  });

  it('accepts each valid authType', () => {
    for (const authType of ['oauth-bloomreach', 'bearer', 'anonymous'] as const) {
      expect(isMcpConfigOverride({ authType })).toBe(true);
    }
  });

  it('rejects unknown authTypes', () => {
    expect(isMcpConfigOverride({ authType: 'unknown' })).toBe(false);
    expect(isMcpConfigOverride({ authType: 42 })).toBe(false);
  });

  it('rejects wrong field types', () => {
    expect(isMcpConfigOverride({ url: 123 })).toBe(false);
    expect(isMcpConfigOverride({ bearerToken: [] })).toBe(false);
  });

  it('rejects non-object inputs', () => {
    expect(isMcpConfigOverride(null)).toBe(false);
    expect(isMcpConfigOverride('string')).toBe(false);
    expect(isMcpConfigOverride(42)).toBe(false);
  });
});

describe('normalizeConfig', () => {
  it('strips empty and whitespace-only strings so env defaults survive', () => {
    expect(normalizeConfig({ url: '', bearerToken: '   ' })).toEqual({
      url: undefined,
      authType: undefined,
      bearerToken: undefined,
    });
  });

  it('trims non-empty strings', () => {
    expect(normalizeConfig({ url: '  https://mcp/  ', bearerToken: ' tok ' })).toEqual({
      url: 'https://mcp/',
      authType: undefined,
      bearerToken: ' tok '.trim(),
    });
  });

  it('preserves authType (enum values, no whitespace to trim)', () => {
    expect(normalizeConfig({ authType: 'bearer' })).toEqual({
      url: undefined,
      authType: 'bearer',
      bearerToken: undefined,
    });
  });
});

describe('encode/decodeConfigHeader round-trip', () => {
  it('encodes and decodes a full config', () => {
    const config = {
      url: 'https://mcp.example.com/',
      authType: 'bearer' as const,
      bearerToken: 'tok',
    };
    const header = encodeConfigHeader(config);
    expect(header).toBeTypeOf('string');
    expect(decodeConfigHeader(header)).toEqual(normalizeConfig(config));
  });

  it('decodes to null for missing / empty inputs', () => {
    expect(decodeConfigHeader(null)).toBeNull();
    expect(decodeConfigHeader('')).toBeNull();
  });

  it('decodes to null for malformed base64', () => {
    expect(decodeConfigHeader('not-base64')).toBeNull();
  });

  it('decodes to null for base64 JSON with invalid shape', () => {
    // base64 of `{"authType":"invalid-type"}`
    const bad = Buffer.from(JSON.stringify({ authType: 'invalid-type' }), 'utf8').toString('base64');
    expect(decodeConfigHeader(bad)).toBeNull();
  });

  it('decodes to null for non-JSON base64 payloads', () => {
    const bad = Buffer.from('this is not json', 'utf8').toString('base64');
    expect(decodeConfigHeader(bad)).toBeNull();
  });

  it('normalizes empty fields on decode', () => {
    const raw = Buffer.from(JSON.stringify({ url: '', authType: 'anonymous' }), 'utf8').toString('base64');
    expect(decodeConfigHeader(raw)).toEqual({ url: undefined, authType: 'anonymous', bearerToken: undefined });
  });
});

describe('localStorage helpers', () => {
  // In Node/vitest the DOM localStorage isn't present; simulate it via a small
  // in-memory shim mounted on globalThis. The helpers already gracefully handle
  // the undefined case for SSR.
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        store = {};
      },
      key: () => null,
      length: 0,
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  });

  it('readPersistedConfig returns null when unset', () => {
    expect(readPersistedConfig()).toBeNull();
  });

  it('readPersistedConfig returns null on malformed JSON', () => {
    store[BI_MCP_CONFIG_KEY] = 'not-json{';
    expect(readPersistedConfig()).toBeNull();
  });

  it('readPersistedConfig returns null on invalid shape', () => {
    store[BI_MCP_CONFIG_KEY] = JSON.stringify({ authType: 'nonsense' });
    expect(readPersistedConfig()).toBeNull();
  });

  it('write → read round-trip', () => {
    writePersistedConfig({ url: 'https://x/', authType: 'anonymous' });
    expect(readPersistedConfig()).toEqual({
      url: 'https://x/',
      authType: 'anonymous',
      bearerToken: undefined,
    });
  });

  it('writing null removes the key', () => {
    store[BI_MCP_CONFIG_KEY] = JSON.stringify({ authType: 'bearer', bearerToken: 't' });
    writePersistedConfig(null);
    expect(store[BI_MCP_CONFIG_KEY]).toBeUndefined();
  });

  it('writing an all-empty config removes the key', () => {
    store[BI_MCP_CONFIG_KEY] = 'anything';
    writePersistedConfig({ url: '', bearerToken: '' });
    expect(store[BI_MCP_CONFIG_KEY]).toBeUndefined();
  });

  it('persistedConfigHeader encodes only when a config is persisted', () => {
    expect(persistedConfigHeader()).toBeNull();
    writePersistedConfig({ authType: 'anonymous' });
    const header = persistedConfigHeader();
    expect(header).toBeTypeOf('string');
    expect(decodeConfigHeader(header)).toEqual({
      url: undefined,
      authType: 'anonymous',
      bearerToken: undefined,
    });
  });
});
