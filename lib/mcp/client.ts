import type { McpTransport } from './transport';

export interface CallToolOptions { cacheTtlMs?: number; skipCache?: boolean; }
export interface CallToolResult<T = unknown> { result: T; durationMs: number; fromCache: boolean; }
interface ClientOpts { minIntervalMs?: number; maxRetries?: number; retryDelayMs?: number; }

function isRateLimited(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
  const text = JSON.stringify((result as any).content ?? result);
  return /rate limit|too many requests/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class McpClient {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;
  private minIntervalMs: number;
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(private transport: McpTransport, opts: ClientOpts = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 200;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 1200;
  }

  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    options: CallToolOptions = {},
  ): Promise<CallToolResult<T>> {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
    const ttl = options.cacheTtlMs ?? 60_000;

    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result as T, durationMs: 0, fromCache: true };
      }
    }

    const start = Date.now();
    let result = await this.liveCall(name, args);

    let retries = 0;
    while (isRateLimited(result) && retries < this.maxRetries) {
      retries++;
      await sleep(this.retryDelayMs);
      result = await this.liveCall(name, args);
    }

    const durationMs = Date.now() - start;

    // Don't cache error results — they should not poison the cache.
    if ((result as any)?.isError === true) {
      return { result: result as T, durationMs, fromCache: false };
    }

    // Note: a skipCache call still refreshes the cache (write-through), which is
    // the desired behavior for the /debug "force fresh" path.
    const now = Date.now();
    this.cache.set(cacheKey, { result, expiresAt: now + ttl });
    return { result: result as T, durationMs, fromCache: false };
  }

  private async liveCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    const result = await this.transport.callTool(name, args);
    this.lastCallAt = Date.now();
    return result;
  }

  /** List the tools the connected MCP server exposes (name, description,
   *  inputSchema). Used by /debug for introspection and by agents to build the
   *  tool schemas they hand to Claude. Not cached — the tool set is stable per
   *  connection and listed rarely. */
  async listTools(): Promise<unknown> {
    return this.transport.listTools();
  }
}
