# 04 — Server error body capture

*Industry standard pattern: response-body interception (a capturing fetch wrapper) — store the body of any non-OK response on a shared holder so the downstream error path can attach it to the thrown exception*

## Zoom out — where this concept lives

The Bloomreach MCP server returns rich error bodies (`invalid_token`, `expired_token`, `rate_limit_exceeded`, EQL parse errors). The MCP SDK consumes the response but does not surface the body in its thrown error — you get `Error('Unauthorized')` with no detail. The capture pattern bridges that gap: a custom `fetch` wrapper records the body of every non-OK response into a holder, and the transport reads from the holder when assembling the thrown error.

```
  Zoom out — where the capturing fetch sits

  ┌─ Service layer ────────────────────────────────────────────┐
  │  /api/briefing, /api/agent                                   │
  └──────────────────────┬──────────────────────────────────────┘
                         │  callTool
  ┌─ Adapter layer ──────▼──────────────────────────────────────┐
  │  BloomreachDataSource → SdkTransport                          │
  └──────────────────────┬──────────────────────────────────────┘
                         │  client.callTool (MCP SDK)
  ┌─ Transport layer ────▼──────────────────────────────────────┐
  │  StreamableHTTPClientTransport                                │
  │    fetch: ★ makeCapturingFetch(holder) ★   ← we are here     │
  └──────────────────────┬──────────────────────────────────────┘
                         │  HTTP
  ┌─ Provider boundary ──▼──────────────────────────────────────┐
  │  Bloomreach loomi connect — returns 401 with                  │
  │  {"error":"invalid_token","error_description":"token revoked"}│
  └──────────────────────────────────────────────────────────────┘
```

Zoom in — the concept. A fetch wrapper (the capturing fetch) wraps every HTTP call. On a non-OK response, it clones the body, redacts it (file 03), truncates to 2KB, and stores it on `HttpErrorHolder`. When the SDK throws its generic error, `SdkTransport.callTool` reads the holder and rebuilds a richer error: `Error('HTTP 401: {"error":"invalid_token","error_description":"token revoked"}')`. The richer error is what the UI's reconnect button uses to detect token revocation; without the body, the error is opaque.

## Structure pass

Axis: **what does the SDK's caller see in the thrown error?**

- Without capture: `Error('Unauthorized')`. Generic. Indistinguishable from any other auth failure.
- With capture: `Error('HTTP 401: {"error":"invalid_token", …}')`. Specific. The client's recovery path can branch on `invalid_token` vs `expired_token` vs `rate_limit_exceeded`.

Seam: the boundary where the answer flips is the SDK's `fetch` option. The SDK calls whatever `fetch` you give it; substituting the capturing wrapper for `globalThis.fetch` is the entire intervention. The SDK doesn't know it's been replaced; the wrapper is transparent on the success path.

## How it works

### Move 1 — the mental model

You know how an HTTP interceptor in axios lets you read every response before the user's `.then` runs? Same pattern, except instead of mutating the response, the wrapper *stashes* the body on a shared object that downstream code (the transport's error handler) reads when something goes wrong.

```
  Pattern — the capturing fetch shape

  client.callTool('execute_analytics_eql', {…})
   │
   ▼
  StreamableHTTPClientTransport (configured with capturing fetch)
   │
   ▼
  capturingFetch(url, init)
   │  await fetch(url, init)              ← real network call
   │
   ▼
  response arrives (status 401, body = {"error":"invalid_token", …})
   │
   ├── status NOT OK?
   │    yes → holder.last = {
   │            status: 401,
   │            body: redactSecrets(text).slice(0, 2000)
   │          }
   │    │
   ▼    ▼
  return response                          ← SDK reads original body via clone
   │
   ▼
  SDK throws Error('Unauthorized')
   │
   ▼
  SdkTransport.callTool catches, reads holder.last,
  throws Error('HTTP 401: {"error":"invalid_token", …}', { cause: SDK error })
```

The trick: the wrapper *clones* the response before reading the body, so the SDK can still read the original. `await res.clone().text()` is what makes the interception non-destructive.

### Move 2 — step by step

#### The holder: shared mutable state between layers

`lib/mcp/transport.ts:22-25`.

```ts
export interface HttpErrorHolder {
  last: { status: number; body: string } | null;
}
```

One field, one record. The holder is shared across the capturing fetch (writer) and the SdkTransport (reader). It's mutable on purpose — the fetch wrapper updates `holder.last` per call, and the transport reads it right after a throw. The lifetime is per-MCP-client (one holder per connected session).

Bridge: this is just a one-slot mailbox. The pattern shows up wherever two functions need to share state through a third-party API that doesn't give you a channel — error context across an SDK boundary, headers across a middleware boundary, request IDs across an async hop.

What breaks if it's a list instead of a one-slot: concurrent calls on the same MCP client race. Today there's no concurrent calls per client (the data source's `lastCallAt` spacing serializes), so one slot is sufficient. If parallelism were added, the holder would need to be keyed by request — a `Map<requestId, HttpErrorHolder>` instead of a singleton.

#### The reset on every call

`lib/mcp/transport.ts:130, 149`:

```ts
async callTool(name, args, opts) {
  if (this.httpErrors) this.httpErrors.last = null;
  …
}
```

Every `callTool` (and `listTools`) call zeros the holder before issuing the call. Without this, a stale error from a previous failed call would attach to the next call's thrown error. The reset is what makes the holder safe to share across calls.

What breaks if the reset is missing: a previous call's "HTTP 429 rate limited" body shows up attached to the next call's "HTTP 401 unauthorized" error. The diagnostic signal is corrupted.

#### The capturing fetch: the interception

`lib/mcp/transport.ts:103-118`.

```ts
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
```

Four moves:

1. Forward the call to the real `fetch`. The wrapper is transparent on the success path.
2. Check `res.ok` (status 200-299). Skip the capture on success.
3. On non-OK, clone the response and read the body as text. The clone is what preserves the original body for the SDK to consume.
4. Redact the body (file 03), truncate to 2KB, store on the holder.

Bridge: if you've ever written an axios response interceptor that read `error.response.data` to surface a server error message in your UI toast, this is the same idea — except the destination is a shared variable instead of the catch block, because the SDK throws *separately* from reading the body.

What breaks if the clone is missing: `await res.text()` consumes the response body. The SDK then tries to read the body and gets nothing — depending on the SDK, this turns into either an empty error message or a "stream already read" exception. The clone is non-negotiable.

What breaks if the truncation is missing: a 50MB error response (yes, this happens — paginated EQL error envelopes) ends up in memory + a future stack trace + Vercel logs. The `MAX_BODY = 2000` cap at `lib/mcp/transport.ts:27` is the bound.

#### The transport: assembling the richer error

`lib/mcp/transport.ts:129-146`:

```ts
async callTool(name, args, opts) {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
  try {
    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
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
```

The catch branches on three cases:

1. **Timeout** (the per-call 30s `AbortSignal.timeout` fired). Throw `HTTP 0: timeout after 30000ms`. The `HTTP 0` marker is intentionally distinct from real HTTP statuses so callers can recognize it.
2. **Captured body present.** Build `HTTP <status>: <body>` and throw. This is the path that surfaces `invalid_token`, `expired_token`, etc. The original SDK error is preserved as `cause`.
3. **Nothing captured.** Re-throw the original. The SDK error wasn't an HTTP-level failure (maybe a JSON parse error inside the SDK, maybe a protocol mismatch).

The `cause` field is what `formatError` in file 03 walks. The chain is `McpToolError → Error('HTTP 401: …') → SDK Error('Unauthorized')` — three levels, all preserved.

What breaks if the transport doesn't read the holder: the throw is just the SDK's generic error. The body is captured (sitting in `holder.last`) but never attached to anything that reaches `console.error`. The capture is wasted; the diagnostic signal disappears.

#### The integration test — the regression guard

`test/mcp/transport.test.ts:44-58`:

```ts
it('attaches the captured server body to a thrown tool error', async () => {
  const holder: HttpErrorHolder = { last: null };
  const client = {
    async callTool() {
      holder.last = { status: 401, body: '{"error":"invalid_token"}' };
      throw new Error('Unauthorized');
    },
  } as unknown as Client;

  const t = new SdkTransport(client, holder);
  await expect(t.callTool('list_cloud_organizations', {})).rejects.toThrow(
    /HTTP 401: \{"error":"invalid_token"\}/,
  );
});
```

This is the test that proves the contract end-to-end. The fake `client` simulates what the SDK + capturing fetch do together: stash a body, then throw. The assertion is on the *enriched* error, not the original SDK error.

A second test (`test/mcp/transport.test.ts:15-33`) verifies the capturing fetch itself — the clone non-destructive read, the holder population, the redaction on capture.

### Move 3 — the principle

**When an SDK eats diagnostic detail, wrap the layer below it.** The HTTP response carried `invalid_token`; the SDK threw `Unauthorized`; the information existed but didn't reach the caller. The fix isn't to patch the SDK — it's to intercept the layer the SDK depends on (the `fetch` it was given) and stash the detail for the caller to pick up. The pattern is reusable: wherever a library eats context, find the function it depends on, wrap that function, and re-introduce the context downstream.

## Primary diagram

```
  body capture, end to end

  agent loop: dataSource.callTool('execute_analytics_eql', {…})
   │
   ▼
  BloomreachDataSource.liveCall:
    holder.last = null                            ← (1) reset
    await this.transport.callTool(name, args, …)
   │
   ▼
  SdkTransport.callTool:
    if (httpErrors) httpErrors.last = null        ← (2) double-reset (belt + braces)
    return await this.client.callTool(…)
   │
   ▼
  MCP SDK Client.callTool → POSTs to Bloomreach
   │
   ▼
  capturingFetch(url, init):
    const res = await fetch(url, init)            ← real network call
    if (!res.ok) {
      holder.last = {                             ← (3) CAPTURE the body
        status: res.status,
        body: redactSecrets(
          (await res.clone().text()).slice(0, MAX_BODY)
        )
      }
    }
    return res
   │
   ▼
  Bloomreach response: 401 {"error":"invalid_token"}
   │
   ▼
  SDK reads body, throws Error('Unauthorized')
   │
   ▼
  SdkTransport catch:
    captured = httpErrors.last                    ← (4) READ the holder
    throw Error(`HTTP 401: {"error":"invalid_token"}`, { cause: sdkErr })
   │
   ▼
  BloomreachDataSource.liveCall catch:
    throw McpToolError('execute_analytics_eql',
      'HTTP 401: …',
      { cause: transportErr })
   │
   ▼
  Route catch:
    console.error('[agent] error:', redactSecrets(formatError(e)))
   │
   ▼
  send({type:'error', message:`/api/agent · HTTP 401: …`})
   │
   ▼
  UI: detects 'invalid_token' substring → triggers reconnect button
```

## Elaborate

Where this pattern comes from: this is the JavaScript version of a much older idea — a logging filter chain in Java's `java.util.logging`, an HTTP middleware in Rack/Express that captures the response body, the "interceptor" pattern in retrofit/axios. The unusual constraint here is that the SDK throws *separately* from reading the body, so the body has to be cached for the catch block to pick up. In a synchronous world the catch would just have the response; in this async-throwing world, a holder is the bridge.

Adjacent concepts: the timeout path at `lib/mcp/transport.ts:131, 150` is a sibling — it composes `AbortSignal.timeout(30_000)` with the route signal so the FIRST one to fire cancels the call. The timeout produces a synthetic `HTTP 0: timeout after 30000ms` error so callers can pattern-match it the same way they pattern-match other HTTP errors. The redaction at file 03 runs both at capture time (here) and again at log time (file 03) — belt and braces; a missed pattern in one place is caught by the other.

What to read next: the Bloomreach alpha-server's rate-limit error envelope is exactly the kind of structured body this pattern is for. The data source's `parseRetryAfterMs` (`lib/data-source/bloomreach-data-source.ts:64-71`) reads the captured body's text via the thrown error's message to decide retry timing. The body capture is what makes that parsing possible.

## Interview defense

**Q: Why not just modify the SDK to surface the response body?**

Three reasons. First, the SDK is a npm dependency — patching it means a fork to maintain or a PR to land upstream. Both are higher-cost than the wrapper. Second, the wrapper is a *contract* the SDK already exposes — the `fetch` option in `StreamableHTTPClientTransport` is the documented seam. Using it is using the SDK correctly, not working around it. Third, this isolates the workaround at the boundary — if a future SDK version starts surfacing bodies natively, you delete the wrapper and the transport's `if (captured)` branch goes dead naturally. The cost of removal stays low. Anchor: `lib/mcp/transport.ts:103-118`.

**Q: Walk me through what happens when a Bloomreach token expires mid-briefing.**

```
  briefing in flight (live mode)
   │
   ▼
  monitoring agent emits its 3rd EQL query
   │
   ▼
  dataSource.callTool('execute_analytics_eql', {…})
   │
   ▼
  capturingFetch:
    fetch → 401 {"error":"invalid_token","error_description":"token revoked"}
    holder.last = { status: 401, body: '{"error":"invalid_token", …}' }
   │
   ▼
  SDK throws Error('Unauthorized')
   │
   ▼
  SdkTransport throws Error('HTTP 401: {"error":"invalid_token", …}', {cause:…})
   │
   ▼
  BloomreachDataSource throws McpToolError('execute_analytics_eql', 'HTTP 401: …')
   │
   ▼
  MonitoringAgent.scan rejects (the agent loop propagates the throw)
   │
   ▼
  Route catch:
    send({type:'error', message:`/api/briefing · execute_analytics_eql → HTTP 401: {"error":"invalid_token", …}`})
    console.error('[briefing] error:', redactSecrets(formatError(e)))
   │
   ▼
  Route finally:
    console.log({route:'/api/briefing', phases:[…], aborted:false, …})  ← totalMs records how far we got
   │
   ▼
  UI receives the error event
    detects 'invalid_token' substring in the message
    triggers reconnect button + resets auth + reloads (guarded against loop)
```

The body capture is the load-bearing link in this chain. Without it, the UI sees `Error: Unauthorized` and has no signal that this is a *revocable token* vs any other 401 (e.g. a fresh tenant with no Bloomreach grant). The recovery affordance branches on the body content. Anchors: `lib/mcp/transport.ts:103-118` (capture), `lib/mcp/transport.ts:138-143` (rebuild), `app/page.tsx` (UI reconnect).

**Q: What's the failure mode if the holder gets stale?**

```
  call N succeeds → holder.last not reset → holder.last is still NULL (set last by an earlier success which never wrote it) ✓
  call N fails    → holder.last gets stale body from call N
  call N+1 starts → resetting holder.last to null
                  → call N+1 succeeds normally → no issue
                  → call N+1 fails differently
                    e.g. SDK throws BEFORE fetch is called (a protocol error)
                    → holder.last is null
                    → SdkTransport catch sees no captured body
                    → re-throws the SDK error as-is

  the discipline: ALWAYS reset before the call, NEVER trust the holder is null
```

The two-reset belt-and-braces is the safety. Both `BloomreachDataSource.liveCall` (no — that one doesn't reset, the data source layer is above the holder) and `SdkTransport.callTool` reset the holder at the top of every call. If a future caller forgets to reset, the stale body shows up attached to an unrelated error and the diagnostic signal lies to you. The reset is what makes the holder safe. Anchor: `lib/mcp/transport.ts:130, 149`.

## See also

- `03-redaction-at-the-error-edge.md` — `redactSecrets` is called *inside* the capturing fetch before the body is stored, so this file's holder never contains a raw token even before the route-layer redaction runs.
- `01-ndjson-reasoning-trace.md` — the `tool_call_end.error` field on a wire event is where this captured body ultimately surfaces to the UI.
- `02-per-request-phase-log.md` — the error log line that the route writes uses the chain assembled here.
- `study-distributed-systems` — the OAuth-token-revocation recovery (the alpha-server scar tissue) is what motivated the body capture in the first place.
