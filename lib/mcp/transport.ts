// lib/mcp/transport.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Minimal surface McpClient depends on. Real impl wraps the MCP SDK Client;
 *  tests provide a fake. */
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<unknown>;
}

/** Holds the body of the most recent failed (non-2xx) HTTP response so the
 *  transport can attach the REAL server error text to a thrown tool error —
 *  the SDK otherwise surfaces only a generic "Unauthorized". */
export interface HttpErrorHolder {
  last: { status: number; body: string } | null;
}

const MAX_BODY = 2000;

/** A fetch wrapper that records the body of any non-OK response into `holder`
 *  (cloning so the SDK can still read the original). Pass it to the SDK's
 *  StreamableHTTPClientTransport `fetch` option. */
export function makeCapturingFetch(holder: HttpErrorHolder): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    if (!res.ok) {
      try {
        holder.last = { status: res.status, body: (await res.clone().text()).slice(0, MAX_BODY) };
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

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.httpErrors) this.httpErrors.last = null;
    try {
      return await this.client.callTool({ name, arguments: args });
    } catch (err) {
      const captured = this.httpErrors?.last;
      if (captured) {
        const body = captured.body.trim();
        throw new Error(`HTTP ${captured.status}${body ? `: ${body}` : ''}`, { cause: err });
      }
      throw err;
    }
  }

  async listTools(): Promise<unknown> {
    if (this.httpErrors) this.httpErrors.last = null;
    try {
      return await this.client.listTools();
    } catch (err) {
      const captured = this.httpErrors?.last;
      if (captured) {
        const body = captured.body.trim();
        throw new Error(`HTTP ${captured.status}${body ? `: ${body}` : ''}`, { cause: err });
      }
      throw err;
    }
  }
}
