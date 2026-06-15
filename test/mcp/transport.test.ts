import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  SdkTransport,
  makeCapturingFetch,
  redactSecrets,
  type HttpErrorHolder,
} from '../../lib/mcp/transport';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('makeCapturingFetch', () => {
  it('records the body of a non-OK response and leaves the original readable', async () => {
    const holder: HttpErrorHolder = { last: null };
    const f = makeCapturingFetch(holder);
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('{"error":"invalid_token","error_description":"token revoked"}', {
          status: 401,
        }),
    );

    const res = await f('https://example.com/mcp');
    expect(res.status).toBe(401);
    expect(holder.last).toMatchObject({ status: 401 });
    expect(holder.last?.body).toContain('invalid_token');
    // the clone must not have consumed the original — the SDK can still read it
    expect(await res.text()).toContain('invalid_token');
  });

  it('does not record on an OK response', async () => {
    const holder: HttpErrorHolder = { last: null };
    const f = makeCapturingFetch(holder);
    vi.stubGlobal('fetch', async () => new Response('ok', { status: 200 }));
    await f('https://example.com/mcp');
    expect(holder.last).toBeNull();
  });
});

describe('SdkTransport error enrichment', () => {
  it('attaches the captured server body to a thrown tool error', async () => {
    const holder: HttpErrorHolder = { last: null };
    const client = {
      async callTool() {
        // simulate the capturing fetch recording the 401 body mid-call
        holder.last = { status: 401, body: '{"error":"invalid_token"}' };
        throw new Error('Unauthorized');
      },
    } as unknown as Client;

    const t = new SdkTransport(client, holder);
    await expect(t.callTool('list_cloud_organizations', {})).rejects.toThrow(
      /HTTP 401: \{"error":"invalid_token"\}/,
    );
  });

  it('falls back to the original error when nothing was captured', async () => {
    const holder: HttpErrorHolder = { last: null };
    const client = {
      async callTool() {
        throw new Error('boom');
      },
    } as unknown as Client;
    const t = new SdkTransport(client, holder);
    await expect(t.callTool('x', {})).rejects.toThrow('boom');
  });
});

describe('redactSecrets', () => {
  it('replaces a Bearer token with [redacted]', () => {
    expect(redactSecrets('Authorization: Bearer abc123XYZ.def_ghi+/=')).toBe(
      'Authorization: [redacted]',
    );
  });

  it('replaces JSON token field values while keeping the key visible', () => {
    expect(redactSecrets('{"access_token":"abc123","ttl":60}')).toBe(
      '{"access_token":"[redacted]","ttl":60}',
    );
    expect(redactSecrets('{"refresh_token":"r-xyz"}')).toBe(
      '{"refresh_token":"[redacted]"}',
    );
    expect(redactSecrets('{"id_token":"eyJ.payload.sig"}')).toBe(
      '{"id_token":"[redacted]"}',
    );
    expect(redactSecrets('{"code_verifier":"verifier-abc"}')).toBe(
      '{"code_verifier":"[redacted]"}',
    );
  });

  it('leaves non-secret text untouched', () => {
    expect(redactSecrets('HTTP 401: {"error":"invalid_token"}')).toBe(
      'HTTP 401: {"error":"invalid_token"}',
    );
  });

  it('redacts a Bearer token in a captured 401 body before storage', async () => {
    const holder: HttpErrorHolder = { last: null };
    const f = makeCapturingFetch(holder);
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          '{"error":"invalid_token","sent":"Bearer eyJabc.def_ghi"}',
          { status: 401 },
        ),
    );

    await f('https://example.com/mcp');
    expect(holder.last?.status).toBe(401);
    expect(holder.last?.body).not.toContain('eyJabc.def_ghi');
    expect(holder.last?.body).toContain('[redacted]');
    // the rest of the envelope should be intact so the error tag stays useful
    expect(holder.last?.body).toContain('invalid_token');
  });
});
