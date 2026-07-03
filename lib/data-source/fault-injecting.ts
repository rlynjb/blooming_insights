// lib/data-source/fault-injecting.ts
//
// Phase-4 fault-injection DataSource decorator. Wraps any concrete
// DataSource (Bloomreach or Synthetic) and forces failures at
// configurable rates. Used offline (load harness, tests) to exercise
// the agents' graceful degradation paths — the same paths that fire
// against real Bloomreach when the alpha server times out or 429s.
//
// The seam has already survived two adapter swaps (Olist added, Olist
// removed, Synthetic added, all without a caller-surface change). The
// fault injector is a third — offline decoration rather than a swap.
//
// Failure modes cover what the tier-2 story defends against:
//   · timeout          — delays past the transport's 30s TOOL_TIMEOUT_MS,
//                          or throws HTTP-0 style timeout error inline
//   · rate_limit       — 429 error carrying a retry-after hint (the
//                          BloomreachDataSource retry ladder shape)
//   · server_error     — 500 error mimicking Bloomreach's error envelope
//   · malformed_json   — returns a ToolResult with garbled content that
//                          the agent's downstream JSON parse will reject
//
// Independent per-error probabilities — one call can only fail one way
// per invocation (whichever error fires first in the check order below).
// Set FAULT_SEED for deterministic runs across test invocations.

import type {
  DataSource,
  DataSourceCallOptions,
  DataSourceCallResult,
  DataSourceListOptions,
} from './types';

export type FaultRates = {
  timeout?: number;
  rateLimit?: number;
  serverError?: number;
  malformedJson?: number;
};

export type FaultInjectorOptions = {
  rates: FaultRates;
  /** Optional deterministic seed. When set, PRNG is xorshift32 with this seed;
   *  otherwise Math.random(). Deterministic seed makes the fault sequence
   *  reproducible across runs — useful for regression tests. */
  seed?: number;
  /** Optional callback fired every time a fault is injected. */
  onFault?: (fault: {
    kind: 'timeout' | 'rate_limit' | 'server_error' | 'malformed_json';
    toolName: string;
    callIndex: number;
  }) => void;
};

/**
 * Wraps a DataSource so a configurable fraction of calls fail in known
 * ways. Preserves the DataSource interface exactly — the underlying
 * adapter (Bloomreach, Synthetic) is untouched.
 */
export class FaultInjectingDataSource implements DataSource {
  private callIndex = 0;
  private prngState: number;

  constructor(
    private readonly inner: DataSource,
    private readonly options: FaultInjectorOptions,
  ) {
    this.prngState = options.seed ?? 0;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult> {
    this.callIndex += 1;

    // Roll a single random number and check each failure mode in order.
    // First mode whose threshold >= roll wins. Higher-severity errors
    // (timeout) checked before lower-severity (malformed content) so a
    // heavy config still yields the more disruptive fault surfaces first.
    const roll = this.random();
    const r = this.options.rates;

    let acc = 0;
    if (r.timeout != null && r.timeout > 0) {
      acc += r.timeout;
      if (roll < acc) return this.fireTimeout(name);
    }
    if (r.rateLimit != null && r.rateLimit > 0) {
      acc += r.rateLimit;
      if (roll < acc) return this.fireRateLimit(name);
    }
    if (r.serverError != null && r.serverError > 0) {
      acc += r.serverError;
      if (roll < acc) return this.fireServerError(name);
    }
    if (r.malformedJson != null && r.malformedJson > 0) {
      acc += r.malformedJson;
      if (roll < acc) return this.fireMalformedJson(name);
    }

    // No fault this call — pass through to the wrapped adapter.
    return this.inner.callTool(name, args, opts);
  }

  listTools(opts?: DataSourceListOptions): Promise<unknown> {
    // Faults are only injected on callTool. listTools stays clean so the
    // agent's bootstrap phase isn't a randomly-failing path.
    return this.inner.listTools(opts);
  }

  private fireTimeout(toolName: string): never {
    this.options.onFault?.({ kind: 'timeout', toolName, callIndex: this.callIndex });
    // Shape mimics lib/mcp/transport.ts:137 — `HTTP 0: timeout after 30000ms`.
    throw new Error(`HTTP 0: timeout after 30000ms`, {
      cause: new Error('injected fault: timeout'),
    });
  }

  private fireRateLimit(toolName: string): never {
    this.options.onFault?.({ kind: 'rate_limit', toolName, callIndex: this.callIndex });
    // Shape mimics BloomreachDataSource retry ladder trigger.
    const err = new Error(`Rate limited: please retry after 2000ms`, {
      cause: new Error('injected fault: rate_limit'),
    });
    (err as Error & { status?: number }).status = 429;
    throw err;
  }

  private fireServerError(toolName: string): never {
    this.options.onFault?.({ kind: 'server_error', toolName, callIndex: this.callIndex });
    const err = new Error(`HTTP 500: Internal server error`, {
      cause: new Error('injected fault: server_error'),
    });
    (err as Error & { status?: number }).status = 500;
    throw err;
  }

  private async fireMalformedJson(toolName: string): Promise<DataSourceCallResult> {
    this.options.onFault?.({ kind: 'malformed_json', toolName, callIndex: this.callIndex });
    // Non-throwing failure: return a result envelope where the payload
    // shape is broken (missing fields, corrupted JSON in a text block).
    // This exercises the agent's downstream type-guard rejection path.
    return {
      result: {
        isError: false,
        content: [
          { type: 'text', text: '{"broken":"unclosed' },
        ],
        structuredContent: undefined,
      },
      durationMs: 42,
      fromCache: false,
    };
  }

  /** xorshift32 PRNG when seeded; Math.random() otherwise. Returns [0, 1). */
  private random(): number {
    if (this.options.seed == null) return Math.random();
    let s = this.prngState;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.prngState = s;
    return (Math.abs(s) % 1_000_000) / 1_000_000;
  }
}
