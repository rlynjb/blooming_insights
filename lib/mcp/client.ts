import type { McpTransport } from './transport';

export interface CallToolOptions { cacheTtlMs?: number; skipCache?: boolean; }
export interface CallToolResult<T = unknown> { result: T; durationMs: number; fromCache: boolean; }
interface ClientOpts {
  minIntervalMs?: number;
  maxRetries?: number;
  /** Fallback wait base when the rate-limit error carries no parseable hint. */
  retryDelayMs?: number;
  /** Upper bound on any single retry wait (parsed hint or backoff). */
  retryCeilingMs?: number;
}

// Small cushion added on top of a server-stated retry window so the retry lands
// just *after* the penalty clears rather than on its boundary.
const RETRY_BUFFER_MS = 500;

function isRateLimited(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as any).isError !== true) return false;
  const text = JSON.stringify((result as any).content ?? result);
  return /rate limit|too many requests/i.test(text);
}

/**
 * Pull a wait hint (ms) out of a Bloomreach rate-limit error envelope. Two
 * shapes are observed in the wild:
 *   "Retry after ~12 second(s)"            → 12_000
 *   "rate limit reached (1 per 10 second)" → 10_000  (the penalty window)
 * Returns null when nothing parseable is present (caller falls back to backoff).
 */
function parseRetryAfterMs(result: unknown): number | null {
  const text = JSON.stringify((result as any)?.content ?? result);
  const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
  if (after) return parseInt(after[1], 10) * 1000;
  const perWindow = text.match(/per\s*(\d+)\s*second/i);
  if (perWindow) return parseInt(perWindow[1], 10) * 1000;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Pull the most useful detail out of a thrown transport error (message + any
 *  nested cause / response body), so the UI shows the real server error rather
 *  than a flat "Unauthorized". */
function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeStr = cause instanceof Error ? cause.message : cause ? safeStringify(cause) : '';
    return causeStr && causeStr !== err.message ? `${err.message} — ${causeStr}` : err.message;
  }
  return safeStringify(err);
}

/** A tool call that failed, tagged with the tool name + the underlying server
 *  detail. Thrown for transport-level failures (e.g. HTTP 401 Unauthorized) and
 *  for tool results that come back as `isError`, so callers can report exactly
 *  which tool failed and why. */
export class McpToolError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`${toolName} → ${detail}`, options);
    this.name = 'McpToolError';
  }
}

export class McpClient {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;
  private minIntervalMs: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private retryCeilingMs: number;

  constructor(private transport: McpTransport, opts: ClientOpts = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 200;
    this.maxRetries = opts.maxRetries ?? 3;
    // Bloomreach's observed penalty window is ~10s ("1 per 10 second"), so a
    // fixed sub-second retry just burns the attempt inside the same window.
    // Default the fallback base to that window; the parsed hint is preferred.
    this.retryDelayMs = opts.retryDelayMs ?? 10_000;
    this.retryCeilingMs = opts.retryCeilingMs ?? 20_000;
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

    // Rate-limit retry. Bloomreach enforces a multi-second global window and
    // states it in the error text; honor the parsed hint, else exponential
    // backoff off retryDelayMs — every wait capped at retryCeilingMs.
    // Latency note: against the 60s route budget (app/api/agent), maxRetries=3
    // at ~10s each can cost ~30s on a *single* call, so the cap stays low by
    // default — raising it risks blowing the per-investigation budget.
    let retries = 0;
    while (isRateLimited(result) && retries < this.maxRetries) {
      retries++;
      const hintMs = parseRetryAfterMs(result);
      const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
      const waitMs = Math.min(
        hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
        this.retryCeilingMs,
      );
      await sleep(waitMs);
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
    try {
      const result = await this.transport.callTool(name, args);
      this.lastCallAt = Date.now();
      return result;
    } catch (err) {
      this.lastCallAt = Date.now();
      // Tag transport-level failures (e.g. a 401) with the tool name so the UI
      // can show which call failed, not just a generic message.
      throw new McpToolError(name, errorDetail(err), { cause: err });
    }
  }

  /** List the tools the connected MCP server exposes (name, description,
   *  inputSchema). Used by /debug for introspection and by agents to build the
   *  tool schemas they hand to Claude. Not cached — the tool set is stable per
   *  connection and listed rarely. */
  async listTools(): Promise<unknown> {
    return this.transport.listTools();
  }
}
