// lib/data-source/olist-data-source.ts
//
// The Olist adapter — second DataSource implementation alongside
// BloomreachDataSource. Spawns the mcp-server-olist subprocess (Node, stdio
// transport), wraps it with an MCP Client, and exposes the DataSource surface.
//
// History: introduced in PR B of Phase 2 (the swap phase). Dormant by default —
// PR C wires it into bi:mode. Until then, this adapter exists, is tested, and
// is importable but no production code path constructs one.
//
// Subprocess lifecycle: one subprocess per OlistDataSource instance, lazy
// started on the first connect()/callTool/listTools call, reused across all
// subsequent calls, killed on dispose(). The MCP server is read-only over a
// SQLite file so concurrent calls (future) would be safe.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DataSource,
  DataSourceCallOptions,
  DataSourceCallResult,
  DataSourceListOptions,
} from './types';

/** Tag for transport / call failures so the agent loop can surface which tool
 *  failed and why. Mirrors `McpToolError` from bloomreach-data-source.ts so the
 *  surface is consistent across adapters. */
export class OlistToolError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`${toolName} → ${detail}`, options);
    this.name = 'OlistToolError';
  }
}

interface OlistDataSourceOptions {
  /** Path to the compiled server entry. Defaults to mcp-server-olist/dist/src/index.js
   *  resolved relative to this file's location at runtime. Override for tests. */
  serverEntry?: string;
  /** node executable. Defaults to `process.execPath`. */
  nodeExecutable?: string;
  /** Per-call default timeout (ms) for an MCP request. Same role as
   *  TOOL_TIMEOUT_MS in lib/mcp/transport.ts. Defaults to 30_000. */
  toolTimeoutMs?: number;
}

/** Compose any number of AbortSignals into one that fires when any source
 *  fires. Same shape as composeSignals() in lib/mcp/transport.ts — kept local
 *  so this file doesn't reach across module boundaries for one helper. */
function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
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
    s.addEventListener(
      'abort',
      () => ac.abort((s as unknown as { reason?: unknown }).reason),
      { once: true },
    );
  }
  return ac.signal;
}

/** Locate mcp-server-olist/dist/src/index.js by walking up from this file's
 *  directory until we find a sibling `mcp-server-olist/` containing the built
 *  entry. Allows the adapter to work both in dev (lib/data-source/ → repo root
 *  → mcp-server-olist/) and from any compiled output position. */
function defaultServerEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(here, '../'.repeat(i), 'mcp-server-olist/dist/src/index.js');
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to a sibling lookup from cwd as a last resort — the error will
  // surface at spawn time with a clearer message if the file truly is absent.
  return resolve(process.cwd(), 'mcp-server-olist/dist/src/index.js');
}

export class OlistDataSource implements DataSource {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly serverEntry: string;
  private readonly nodeExecutable: string;
  private readonly toolTimeoutMs: number;

  constructor(opts: OlistDataSourceOptions = {}) {
    this.serverEntry = opts.serverEntry ?? defaultServerEntry();
    this.nodeExecutable = opts.nodeExecutable ?? process.execPath;
    this.toolTimeoutMs = opts.toolTimeoutMs ?? 30_000;
  }

  /** Lazy-connect on first use. Idempotent — concurrent callers share one
   *  in-flight promise so the subprocess is spawned exactly once per instance. */
  async connect(): Promise<void> {
    if (this.client) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    if (!existsSync(this.serverEntry)) {
      throw new Error(
        `OlistDataSource: server entry not found at ${this.serverEntry}. ` +
          `Run 'npm run build' in mcp-server-olist/ first.`,
      );
    }
    const transport = new StdioClientTransport({
      command: this.nodeExecutable,
      args: [this.serverEntry],
      // Inherit stderr so any [mcp-server-olist] ready/log lines surface in the
      // parent process. The MCP SDK reserves stdin/stdout for protocol frames.
      stderr: 'inherit',
    });
    const client = new Client(
      { name: 'blooming-insights-olist-adapter', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.transport = transport;
    this.client = client;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult> {
    await this.connect();
    if (!this.client) throw new Error('OlistDataSource: client not connected');

    const signal = composeSignals(opts?.signal, AbortSignal.timeout(this.toolTimeoutMs));
    const start = Date.now();
    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { signal },
      );
      const durationMs = Date.now() - start;
      // OlistDataSource has no cache yet (TODO for parity with BloomreachDataSource
      // if needed) — always report fromCache=false.
      return { result, durationMs, fromCache: false };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new OlistToolError(name, detail, { cause: err });
    }
  }

  async listTools(opts?: DataSourceListOptions): Promise<unknown> {
    await this.connect();
    if (!this.client) throw new Error('OlistDataSource: client not connected');
    const signal = composeSignals(opts?.signal, AbortSignal.timeout(this.toolTimeoutMs));
    return this.client.listTools(undefined, { signal });
  }

  /** Tear down the subprocess + client cleanly. Idempotent. */
  async dispose(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    }
    if (transport) {
      try {
        await transport.close();
      } catch {
        // best-effort
      }
    }
  }
}
