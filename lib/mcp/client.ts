import type { McpTransport } from './transport';

export interface CallToolOptions { cacheTtlMs?: number; skipCache?: boolean; }
export interface CallToolResult<T = unknown> { result: T; durationMs: number; fromCache: boolean; }
interface ClientOpts { minIntervalMs?: number; }

export class McpClient {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;
  private minIntervalMs: number;

  constructor(private transport: McpTransport, opts: ClientOpts = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 200;
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

    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }

    const start = Date.now();
    const result = await this.transport.callTool(name, args);
    const durationMs = Date.now() - start;
    this.lastCallAt = Date.now();

    this.cache.set(cacheKey, { result, expiresAt: Date.now() + ttl });
    return { result: result as T, durationMs, fromCache: false };
  }
}
