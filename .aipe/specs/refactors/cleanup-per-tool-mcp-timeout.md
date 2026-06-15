# Refactor: Per-tool timeout on MCP calls

## What to refactor

- `lib/mcp/transport.ts:47-59` — `SdkTransport.callTool`, the single funnel for every Bloomreach MCP call. Today it `await`s `this.client.callTool({ name, arguments: args })` with no upper bound.
- `lib/mcp/transport.ts:61-73` — `SdkTransport.listTools`, same shape (lower priority but same fix mechanism for consistency).
- `lib/mcp/client.ts:94` — `retryCeilingMs: 20_000` is the existing ceiling-shape comment that documents the rationale. Add a sibling constant for the transport timeout next to it (or near the new code) so the two ceilings live side by side.

## Why

A Bloomreach connection that hangs forever burns the entire 300s route budget on one stuck call. There is no signal in the UI, no recovery in the retry ladder, no way to bound the worst case (cleanup-2026-06-02 fix-now #5, `study-system-design/audit.md` HIGH finding #2). The retry ladder in `McpClient.callTool` is good defense against *failed* calls; this is defense against the *never-returns* call — a different failure mode that retry-with-backoff doesn't catch.

Severity: high. Effort: ~15 LOC inside `SdkTransport.callTool` + an `AbortSignal.timeout` (or `Promise.race`) primitive. Zero public API change — `McpClient` already catches thrown errors and tags them via `McpToolError`, so the timeout simply throws and rides the existing failure path.

## Target structure

Prefer `AbortSignal.timeout(TOOL_TIMEOUT_MS)` if the SDK's `client.callTool` accepts a signal (check `node_modules/@modelcontextprotocol/sdk/client/index.d.ts`):

```
const TOOL_TIMEOUT_MS = 30_000;  // sibling of retryCeilingMs: 20_000

async callTool(name, args) {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = AbortSignal.timeout(TOOL_TIMEOUT_MS);
  try {
    return await this.client.callTool({ name, arguments: args }, { signal });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
    }
    // existing capturing-fetch attach
    const captured = this.httpErrors?.last;
    if (captured) {
      const body = captured.body.trim();
      throw new Error(`HTTP ${captured.status}${body ? `: ${body}` : ''}`, { cause: err });
    }
    throw err;
  }
}
```

If the SDK does NOT accept a signal, fall back to `Promise.race([call, timeoutPromise(TOOL_TIMEOUT_MS)])`. The race's losing side leaks (the SDK keeps running until the connection closes naturally), but the route returns to the user — acceptable for a serverless instance where the process recycles anyway.

The `30_000` ms ceiling matches the rate-limit-retry shape: `retryCeilingMs: 20_000` is one bound, `TOOL_TIMEOUT_MS: 30_000` is the other. Sibling constants, sibling rationale.

Behaviour-preserving claim: every call that succeeds within 30s is bit-identical to before. Every call that hangs gets a tagged `McpToolError` that the existing retry ladder + the `errorDetail` helper already know how to surface. No new UI state, no new event type on the NDJSON wire.

## Must not change

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->

## Must not introduce

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->
