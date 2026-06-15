// lib/mcp/transport.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Optional per-call options threaded from the route layer down to the SDK.
 *  Today the only field is `signal`, which composes with the transport's own
 *  `AbortSignal.timeout(TOOL_TIMEOUT_MS)` so the FIRST signal to fire wins —
 *  either the client cancelling the request, or the per-call 30s ceiling. */
export interface CallToolOpts {
  signal?: AbortSignal;
}

/** Minimal surface McpClient depends on. Real impl wraps the MCP SDK Client;
 *  tests provide a fake. */
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>, opts?: CallToolOpts): Promise<unknown>;
  listTools(opts?: CallToolOpts): Promise<unknown>;
}

/** Holds the body of the most recent failed (non-2xx) HTTP response so the
 *  transport can attach the REAL server error text to a thrown tool error —
 *  the SDK otherwise surfaces only a generic "Unauthorized". */
export interface HttpErrorHolder {
  last: { status: number; body: string } | null;
}

const MAX_BODY = 2000;

/** Per-call upper bound on a single MCP tool/listTools round-trip. A hung
 *  Bloomreach connection would otherwise burn the entire 300s route budget on
 *  one stuck call. Sibling of `retryCeilingMs: 20_000` in client.ts — that
 *  ceiling bounds a rate-limit retry wait, this one bounds the request itself.
 *  Thrown as `HTTP 0: timeout after 30000ms`, riding the existing transport
 *  failure path (McpClient.liveCall already wraps it in McpToolError). The
 *  retry ladder in McpClient.callTool only retries successful-but-rate-limited
 *  results, so the timeout error fails fast — exactly what we want, since a
 *  retry would just risk another 30s wait inside the same route budget. */
const TOOL_TIMEOUT_MS = 30_000;

/** True when `err` came from an aborted/timed-out signal. The SDK surfaces
 *  timeouts as either a DOMException-shaped `AbortError`/`TimeoutError` (from
 *  `AbortSignal.timeout`) or as its own `McpError` with `code: RequestTimeout`.
 *  Match by name so we don't depend on importing McpError just for this check. */
function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('name' in err)) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Patterns whose matches reveal a Bloomreach/OAuth credential. Bearer headers
 *  ride every MCP call and OAuth bodies carry token fields; when either ends up
 *  in `err.cause` (some failure modes attach the request envelope), the secret
 *  flows into the surfaced error detail and into Vercel logs. Redacting before
 *  the body is stored prevents the leak at the source. */
const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  /"access_token"\s*:\s*"[^"]+"/g,
  /"refresh_token"\s*:\s*"[^"]+"/g,
  /"id_token"\s*:\s*"[^"]+"/g,
  /"code_verifier"\s*:\s*"[^"]+"/g,
];

/** Replace any token-shaped substring with `[redacted]`. Bearer matches collapse
 *  to a bare `[redacted]`; JSON field matches keep their key so the shape of the
 *  surrounding envelope stays readable (`"access_token":"[redacted]"`). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (match) => {
      if (match.startsWith('Bearer')) return '[redacted]';
      const key = match.match(/"([^"]+)"\s*:/)?.[1];
      return key ? `"${key}":"[redacted]"` : '[redacted]';
    });
  }
  return out;
}

/** Walk an error's `cause` chain into one string. `console.error(e)` formats
 *  nested causes via Node's util.inspect, but plain `String(e)` does not — so
 *  we assemble the chain ourselves before redacting, otherwise a token nested
 *  inside `e.cause.cause` would survive the redaction and reach Vercel logs. */
export function formatError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < 5) {
    if (cur instanceof Error) {
      parts.push(cur.stack ?? cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      cur = null;
    }
    depth++;
  }
  return parts.join('\n  caused by: ');
}

/** A fetch wrapper that records the body of any non-OK response into `holder`
 *  (cloning so the SDK can still read the original). Pass it to the SDK's
 *  StreamableHTTPClientTransport `fetch` option. The stored body is redacted
 *  first so a Bearer/OAuth token in an error envelope never reaches logs. */
export function makeCapturingFetch(holder: HttpErrorHolder): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    if (!res.ok) {
      try {
        holder.last = {
          status: res.status,
          body: redactSecrets((await res.clone().text()).slice(0, MAX_BODY)),
        };
      } catch {
        /* body unreadable / already consumed — leave the holder as-is */
      }
    }
    return res;
  };
}

/** Wraps a connected MCP SDK Client. Connection/auth handled in auth.ts/connect.ts.
 *  When a call fails and `httpErrors` captured a non-OK response, the raw server
 *  body is attached so callers see exactly what the server returned. */
export class SdkTransport implements McpTransport {
  constructor(
    private client: Client,
    private httpErrors?: HttpErrorHolder,
  ) {}

  async callTool(name: string, args: Record<string, unknown>, opts?: CallToolOpts): Promise<unknown> {
    if (this.httpErrors) this.httpErrors.last = null;
    const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
    try {
      return await this.client.callTool({ name, arguments: args }, undefined, { signal });
    } catch (err) {
      // Timeout path — distinct `HTTP 0:` tag so callers can recognize it.
      if (isTimeoutError(err)) {
        throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
      }
      const captured = this.httpErrors?.last;
      if (captured) {
        const body = captured.body.trim();
        throw new Error(`HTTP ${captured.status}${body ? `: ${body}` : ''}`, { cause: err });
      }
      throw err;
    }
  }

  async listTools(opts?: CallToolOpts): Promise<unknown> {
    if (this.httpErrors) this.httpErrors.last = null;
    const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
    try {
      return await this.client.listTools(undefined, { signal });
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
      }
      const captured = this.httpErrors?.last;
      if (captured) {
        const body = captured.body.trim();
        throw new Error(`HTTP ${captured.status}${body ? `: ${body}` : ''}`, { cause: err });
      }
      throw err;
    }
  }
}

/** Compose any number of AbortSignals into one — the result fires as soon as
 *  any source fires. Prefers `AbortSignal.any` (Node 20+ / modern browsers) and
 *  falls back to a manual `AbortController` glue (no-op in this env, kept for
 *  belt-and-braces against older runtimes). Used by `SdkTransport` to OR the
 *  client-cancel signal with the per-call 30s `AbortSignal.timeout` — whichever
 *  fires first cancels the in-flight MCP call. */
export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => !!s);
  if (filtered.length === 0) return new AbortController().signal;
  if (filtered.length === 1) return filtered[0];
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(filtered);
  }
  const ac = new AbortController();
  for (const s of filtered) {
    if (s.aborted) {
      ac.abort((s as unknown as { reason?: unknown }).reason);
      return ac.signal;
    }
    s.addEventListener('abort', () => ac.abort((s as unknown as { reason?: unknown }).reason), { once: true });
  }
  return ac.signal;
}
