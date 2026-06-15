import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  SdkTransport,
  makeCapturingFetch,
  redactSecrets,
  formatError,
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

describe('SdkTransport per-call timeout', () => {
  it('returns the call result bit-identical when the SDK resolves quickly', async () => {
    // Sanity check that the AbortSignal.timeout wrap does not alter the
    // success path — the resolved value must flow through untouched.
    const expected = { content: [{ type: 'text', text: 'ok' }], isError: false };
    const client = {
      async callTool() {
        return expected;
      },
    } as unknown as Client;
    const t = new SdkTransport(client);
    await expect(t.callTool('any_tool', {})).resolves.toBe(expected);
  });

  it('passes an AbortSignal to the SDK so the transport can cancel', async () => {
    // Pin the contract: we hand the SDK a signal in `options`. The SDK uses
    // it both to abort the underlying request and (via `AbortSignal.timeout`)
    // to trip after TOOL_TIMEOUT_MS without the SDK needing its own clock.
    let receivedSignal: AbortSignal | undefined;
    const client = {
      async callTool(
        _params: unknown,
        _schema: unknown,
        options: { signal?: AbortSignal } | undefined,
      ) {
        receivedSignal = options?.signal;
        return { ok: true };
      },
    } as unknown as Client;
    const t = new SdkTransport(client);
    await t.callTool('any_tool', {});
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it('throws "HTTP 0: timeout after 30000ms" when the SDK rejects with TimeoutError', async () => {
    // Simulate the SDK respecting the passed signal: when the timeout fires,
    // the SDK rejects with a DOMException-shaped error whose `name` is
    // `TimeoutError`. The transport must recognise that and surface the
    // canonical HTTP 0 tag, so callers / errorDetail render it cleanly.
    // Rejecting synchronously avoids waiting on the real 30s timer; the
    // contract under test is the `isTimeoutError` branch, not the clock.
    const client = {
      async callTool() {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      },
    } as unknown as Client;
    const t = new SdkTransport(client);
    await expect(t.callTool('hangs_forever', {})).rejects.toThrow(
      /HTTP 0: timeout after 30000ms/,
    );
  });

  it('preserves the underlying timeout error as `cause`', async () => {
    const client = {
      async callTool() {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    } as unknown as Client;
    const t = new SdkTransport(client);
    try {
      await t.callTool('hangs', {});
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const cause = (err as Error & { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).name).toBe('AbortError');
    }
  });

  it('listTools applies the same timeout wrap', async () => {
    const client = {
      async listTools() {
        const err = new Error('timeout');
        err.name = 'TimeoutError';
        throw err;
      },
    } as unknown as Client;
    const t = new SdkTransport(client);
    await expect(t.listTools()).rejects.toThrow(/HTTP 0: timeout after 30000ms/);
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

describe('formatError', () => {
  it('walks the cause chain so nested messages all reach the formatted string', () => {
    // Pin the contract that the 6 route handlers depend on: the helper has to
    // descend through `cause` so a token nested inside `e.cause.cause` ends up
    // in the string and can be redacted — otherwise `String(e)` alone would
    // hide it from `redactSecrets` and leak to Vercel logs.
    const e = new Error('top', {
      cause: new Error('mid', { cause: new Error('bottom') }),
    });
    const out = formatError(e);
    expect(out).toContain('top');
    expect(out).toContain('mid');
    expect(out).toContain('bottom');
  });

  it('falls back to String() when handed a non-Error value', () => {
    // The catch blocks pass `unknown`, so the helper has to accept anything
    // and still produce something log-shaped.
    expect(formatError('not an error')).toBe('not an error');
  });
});
