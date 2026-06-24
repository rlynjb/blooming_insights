# McpClient (now BloomreachDataSource) as the deep module

**Industry name(s):** Deep module · information hiding · narrow interface over fat implementation (Ousterhout)
**Type:** Industry standard · Language-agnostic (one of two canonical deep-module examples in this repo)

> **POST-2026-06-15 NOTE.** This class was renamed and moved in Phase 2 PR A: `McpClient` → `BloomreachDataSource`, `lib/mcp/client.ts` → `lib/data-source/bloomreach-data-source.ts`. The internals didn't change — the class was already shaped to be the Bloomreach adapter; lifting `DataSource` over it only changed the type that callers consume. `lib/mcp/client.ts` survives as a 17-line shim re-exporting `BloomreachDataSource as McpClient` so existing test imports compile unchanged. **All file references below are updated to the new path; the depth analysis still holds.** A second deep-module case study has emerged at the seam level — the `DataSource` interface + `makeDataSource` factory — see the audit's deep-vs-shallow-modules lens for the deep walk.

> `BloomreachDataSource` (214 LOC, was 172) exposes three methods — constructor, `callTool`, `listTools` — and absorbs six independent mechanics: TTL cache, spacing gate, retry loop with parsed `Retry-After`, error tagging, write-on-success caching, and the Bloomreach error-grammar parsing. The caller learns three signatures; the body absorbs the entire MCP-rate-limit reality. This was the canonical deep module in 2026-06-02 and remains one of two now (the other being the DataSource seam itself).

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** `McpClient` sits at the bottom of the agent stack. Every tool call from every agent passes through one method on this class. Above it: the four agent classes, the route handlers, the UI. Below it: the SDK transport. Strip `McpClient` out and you'd push four mechanics back into every caller — every agent would have to do its own cache lookup, its own retry parsing, its own spacing, its own error tagging. The class earns its place by being the *only* file in the codebase that knows the Bloomreach grammar.

```
Zoom out — where McpClient sits

┌─ UI layer (client) ─────────────────────────────────────────────┐
│  app/page.tsx · NDJSON consumer                                  │
└──────────────────────────────────────────┬──────────────────────┘
                                           │ HTTP / NDJSON
┌─ Route layer ────────────────────────────▼──────────────────────┐
│  /api/briefing  /api/agent                                       │
└──────────────────────────────────────────┬──────────────────────┘
                                           │ runAgentLoop(opts)
┌─ Agent layer ────────────────────────────▼──────────────────────┐
│  MonitoringAgent · DiagnosticAgent · RecommendationAgent ·      │
│  QueryAgent                                                      │
└──────────────────────────────────────────┬──────────────────────┘
                                           │ mcp.callTool(name, args, opts?)
┌─ MCP wrapper layer ──────────────────────▼──────────────────────┐
│  ★ McpClient ★ (172 LOC, 3 methods)   ← we are here              │
│    callTool() hides:                                             │
│      · TTL cache  · spacing gate  · retry parsing                │
│      · error tagging  · write-on-success                         │
└──────────────────────────────────────────┬──────────────────────┘
                                           │ transport.callTool(name, args)
┌─ Transport layer ────────────────────────▼──────────────────────┐
│  SdkTransport (adds HTTP error body capture)                     │
└─────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The pattern is the depth ratio: how big is the body divided by how wide is the doorway? Three methods on top, 172 LOC of mechanics below. The kernel here isn't "MCP client" — it's "one class owns every Bloomreach-specific rate-limit detail, so the rest of the codebase can pretend rate limits don't exist." That's what makes it a deep module rather than a thin wrapper around the SDK.

---

## Structure pass

**Layers.** Two for this concept: the **public interface** (what every caller in the codebase reads) and the **implementation** (what `McpClient` absorbs that those callers don't see). Depth is the ratio between them.

**Axis: knowledge ownership.** For each fact about MCP rate-limiting (the error grammar, the penalty window, the retry strategy, the cache key shape), which module owns it? In a deep module, the answer is "this one." In a shallow wrapper, the answer is "every caller." Trace knowledge across the wrapper-callers seam and the contrast pops — six facts, one owner.

**Seams.** One seam matters: **caller ↔ `McpClient.callTool`**. The caller passes `(name, args, opts?)` and reads `{ result, durationMs, fromCache }`. Trace control across this seam (the caller decides *what* to call; the wrapper decides *how* to call it — when to wait, when to retry, when to fail). Trace state (the caller owns nothing; the wrapper owns cache + lastCallAt). Trace failure (rate-limit failures don't cross the seam at all — they're masked low; transport failures cross transformed as `McpToolError`). All three axes flip at this one boundary. That's a load-bearing seam.

```
Structure pass — the load-bearing seam

┌─ 1. LAYERS ──────────────────────────────────────────────┐
│  Public interface · Implementation                         │
│  (3 methods)        (172 LOC of mechanics)                │
└─────────────────────────────┬────────────────────────────┘
                              │  pick the axis
┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
│  knowledge ownership: which side knows the Bloomreach     │
│  rate-limit grammar, cache shape, retry strategy?         │
└─────────────────────────────┬────────────────────────────┘
                              │  trace across the seam
┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
│  caller ↔ McpClient.callTool                              │
│   control flips:  caller picks tool, wrapper picks timing │
│   state flips:    caller stateless, wrapper holds cache   │
│   failure flips:  rate-limits never cross; transport      │
│                    failures cross tagged                  │
└─────────────────────────────┬────────────────────────────┘
                              ▼
                      Block 4 — How it works
```

---

## How it works

### Move 1 — the mental model (the depth ratio)

You know how `localStorage.setItem(key, value)` works without you knowing whether the browser writes to disk, to IndexedDB, or to memory? You also don't know whether it batches writes, whether it compresses, whether it throws on quota exceeded vs returns false. That's the shape: the caller learns one method signature, the implementation absorbs a pile of decisions the caller never has to make. Same pattern here, applied to MCP rate limiting.

```
The depth ratio — picture

  ┌─ caller's mental model ─────────────────────────────────┐
  │  mcp.callTool('execute_eql', { query: '...' })           │
  │  → { result, durationMs, fromCache }                     │
  └─────────────────────────────┬────────────────────────────┘
                                │  what's hidden below
                                ▼
  ┌─ McpClient's body ──────────────────────────────────────┐
  │  1. cache lookup         (key = name:JSON.stringify args) │
  │  2. spacing gate         (sleep to honor minIntervalMs)   │
  │  3. live transport call                                   │
  │  4. is-rate-limited?     (regex on error envelope)        │
  │  5. parse retry-after    (two prose formats, one regex)   │
  │  6. wait + retry         (parsed hint OR exponential)     │
  │  7. tag failures         (McpToolError with tool name)    │
  │  8. write to cache       (only on non-error envelope)     │
  └─────────────────────────────────────────────────────────┘

  ratio: 1 method exposed, 8 mechanics absorbed.
```

### Move 2 — the kernel

Walk the kernel one moving part at a time. Each part is named by what breaks when it's missing.

**The cache (TTL Map, write-on-success only).** A `Map<key, {result, expiresAt}>` keyed on `name + JSON.stringify(args)`. TTL defaults to 60s but the caller can override per-call. Critically, the cache writes ONLY when the result is non-error — caching a rate-limit envelope would lock subsequent retries to the same failure for the window. Drop the cache: every repeated tool call hits the rate limit; investigations that revisit `execute_analytics_eql` with the same args burn budget.

**The spacing gate.** Before every live call, `await sleep(minIntervalMs - (Date.now() - lastCallAt))` enforces a minimum gap between transport hits. Defaults to 200ms; production overrides to 1100ms because the Bloomreach alpha server enforces ~1 req/s globally. Drop the gate: the first burst of 6 tool calls in an investigation triggers the penalty window before the cache has anything to absorb.

**The retry loop with parsed `Retry-After`.** When the wrapper sees `isRateLimited(result) === true`, it loops up to `maxRetries` (default 3) times. Each iteration: parse the wait hint from the error prose (`parseRetryAfterMs`), fall back to `retryDelayMs * 2^retries` if no hint, cap at `retryCeilingMs`, sleep, re-call. Drop the loop: a single 429 from Bloomreach kills the whole investigation; the next contributor adds a try/catch at every call site.

**The error tag (`McpToolError`).** A small class with `toolName` and `detail` fields. The wrapper throws this whenever the transport raises, wrapping the underlying error as `cause`. Drop the tag: the UI shows "Unauthorized" instead of "`list_projects → invalid_token`" and the user has no idea which tool failed.

```
Pattern — the kernel as a flow

  callTool(name, args, opts)
       │
       ├── cache lookup (hit?) ──► return {result, fromCache: true, durationMs: 0}
       │   (miss or skipCache)
       ▼
   liveCall(name, args)
       │
       ├── spacing sleep (gate)
       ▼
   transport.callTool(name, args)
       │
       │  (error envelope?)
       ▼
   isRateLimited(result)? ──── yes ──► parse retry-after → sleep → retry (up to N)
       │
       │  (no, success)
       ▼
   cache.set(key, result)  ── only when !isError
       │
       ▼
   return { result, durationMs, fromCache: false }
```

### Move 2 — the irreducible parts

```
The kernel as load-bearing parts

  PUBLIC SURFACE                  what callers know
  ──────────────────────────────────────────────────────────
  callTool(name, args, opts?)     → { result, durationMs, fromCache }
  listTools()                     → Promise<unknown>
  new McpClient(transport, opts?)

  ABSORBED IMPLEMENTATION         what callers DON'T know
  ──────────────────────────────────────────────────────────
  cache: Map<key, entry>          (private state)
  lastCallAt: number              (private state)
  parseRetryAfterMs()             (the grammar — module-private fn)
  isRateLimited()                 (the detection — module-private fn)
  RETRY_BUFFER_MS = 500           (module-private constant)
```

Each line in the "absorbed implementation" column is a fact that, if leaked upward, would force every caller to learn it. The wrapper is the choice to keep them all here.

### Move 3 — the principle

The deep module is the discipline that lets the rest of the codebase pretend hard things are easy. Bloomreach has a global per-user rate limit, two error prose formats, an observed 10s penalty window, and a transport that occasionally returns 401 mid-investigation. From the agent loop's view, none of that exists — there's just `mcp.callTool(name, args)` and you either get a result or you get a tagged error you can handle once. That's the trade: one module absorbs the reality, every other module is simpler. Drive interface size down, drive hidden behavior up. That's the whole game.

---

## Primary diagram

The full picture — the seam, the kernel, the eight mechanics absorbed.

```
McpClient — the deep-module recap

   caller                                        ┌─ McpClient.callTool ────────────────┐
   ┌────────────────────────┐  name, args, opts  │                                      │
   │  agent / route / UI    │ ─────────────────► │  1. cache.get(key)                   │
   └────────────────────────┘                    │     hit → return                     │
                                                 │     miss ↓                            │
                                                 │  2. liveCall(name, args)             │
                                                 │       a. spacing sleep                │
                                                 │       b. transport.callTool          │
                                                 │       c. catch → McpToolError        │
                                                 │  3. while isRateLimited(result):     │
                                                 │       a. parseRetryAfterMs(result)   │
                                                 │       b. sleep(hint ?? backoff)      │
                                                 │       c. liveCall again              │
                                                 │  4. if !isError: cache.set(key,…)    │
                                                 │  5. return { result, durationMs,     │
                                                 │              fromCache: false }      │
   ┌────────────────────────┐                    └──────────────────────────────────────┘
   │  { result, durationMs, │ ◄────────────────────────────
   │    fromCache }         │
   └────────────────────────┘

   surface: 3 methods.  body: ~172 LOC of mechanics.
   every caller in the repo gets the simple shape.
```

---

## Implementation in codebase

**Use cases.** Every tool call from every agent passes through `McpClient`. Concrete scenarios:

- A monitoring scan runs `execute_analytics_eql` 6 times in one investigation. Without the wrapper, the second call would hit the per-second rate limit; with the cache + spacing, repeats are free and new calls are paced.
- A diagnostic investigation gets a 429 mid-run because another tab on the same user account also hit Bloomreach. The retry loop parses "Retry after ~12 second(s)" from the error envelope and waits 12.5s. The agent loop never sees the retry; the investigation completes one turn slower.
- The UI shows "list_projects → invalid_token" after a revoked OAuth credential. That message exists because `liveCall` wraps the transport's raised error in `McpToolError(name, detail)` — without the wrapper, the UI would show a generic "Unauthorized."

### The class shape and the kernel

```
lib/mcp/client.ts  (lines 79–172)

  export class McpClient {
    private cache = new Map<string, { result: unknown; expiresAt: number }>();  ← hidden state
    private lastCallAt = 0;                                                      ← hidden state
    private minIntervalMs: number;                                               ← hidden config
    private maxRetries: number;
    private retryDelayMs: number;
    private retryCeilingMs: number;

    constructor(private transport: McpTransport, opts: ClientOpts = {}) {
      this.minIntervalMs = opts.minIntervalMs ?? 200;
      this.maxRetries = opts.maxRetries ?? 3;
      this.retryDelayMs = opts.retryDelayMs ?? 10_000;   ← Bloomreach window default
      this.retryCeilingMs = opts.retryCeilingMs ?? 20_000;
    }

    async callTool<T>(name, args, options = {}): Promise<CallToolResult<T>> {
      const cacheKey = `${name}:${JSON.stringify(args)}`;
      const ttl = options.cacheTtlMs ?? 60_000;

      if (!options.skipCache) {                          ← TRANSFORM 1: cache lookup
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          return { result: cached.result as T, durationMs: 0, fromCache: true };
        }
      }

      const start = Date.now();                           ← TRANSFORM 2: duration timing
      let result = await this.liveCall(name, args);

      let retries = 0;                                    ← TRANSFORM 3: retry loop
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

      if ((result as any)?.isError === true) {            ← TRANSFORM 4: error not cached
        return { result: result as T, durationMs, fromCache: false };
      }

      this.cache.set(cacheKey, { result, expiresAt: Date.now() + ttl });  ← TRANSFORM 5: cache write
      return { result: result as T, durationMs, fromCache: false };
    }

    private async liveCall(name, args) {                  ← private = hidden
      const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastCallAt));
      if (wait > 0) await sleep(wait);
      try {
        const res = await this.transport.callTool(name, args);
        this.lastCallAt = Date.now();
        return res;
      } catch (err) {
        this.lastCallAt = Date.now();
        throw new McpToolError(name, errorDetail(err), { cause: err });   ← tag the error
      }
    }

    async listTools(): Promise<unknown> {
      return this.transport.listTools();                  ← the one pass-through (justified)
    }
  }
       │
       └─ a caller writes:
            const { result, fromCache } = await mcp.callTool('list_projects', { ... })
          and learns NOTHING about cache, retry, spacing, or error tagging.
          that's the depth ratio paying for itself.
```

### The hidden grammar — `parseRetryAfterMs`

```
lib/mcp/client.ts  (lines 24–38)

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
       │
       └─ this is the only place in the codebase that knows the Bloomreach
          error grammar. grep the repo for /retry-after/ — only this file matches.
          if Bloomreach adds a third prose format, exactly one file changes.
          that's the strongest hide in the repo.
```

### Production tuning at construction — the earned override

```
lib/mcp/connect.ts  (lines 82–96)

    // Bloomreach rate-limits per user GLOBALLY and states the window in the
    // error text — observed as both "(1 per 1 second)" and "(1 per 10 second)".
    // Proactive spacing stays at ~1.1s on purpose: spacing at the full 10s
    // window would cost ~60s for a 6-call investigation and blow the route's
    // 60s budget (app/api/agent). Instead, McpClient parses the stated window
    // from each 429 and waits it out on retry (see retryDelayMs/retryCeilingMs),
    // and the 60s response cache absorbs repeats.
    return {
      ok: true,
      mcp: new McpClient(new SdkTransport(client, httpErrors), {
        minIntervalMs: 1100,        ← prod-specific override
        retryDelayMs: 10_000,
        retryCeilingMs: 20_000,
        maxRetries: 3,
      }),
    };
       │
       └─ overrides happen ONCE, at construction, in a single file the per-call
          code never touches. defaults work for tests; production tunes here.
```

---

## Elaborate

Where the pattern comes from: Ousterhout's *A Philosophy of Software Design* names "deep module" as the central design unit — a class or function whose interface is small relative to the behavior it absorbs. The opposite (classitis: every tiny operation gets its own class with its own constructor) is the failure mode the depth ratio is meant to prevent. `McpClient` is the textbook shape: small public surface, fat private body, every fact about the underlying system owned in one place.

Adjacent concepts:
- **Information hiding** — depth requires hiding. If the cache key shape or the retry grammar leaked into a caller, the depth would collapse. The `parseRetryAfterMs` example is the hide that makes the depth possible.
- **Pull complexity downward** — every knob in the constructor (`minIntervalMs`, `maxRetries`, `retryDelayMs`) is defaulted, with production overriding once. The module decided; callers don't carry the decision.
- **Errors as a contract** — the wrapper masks rate-limit errors entirely and transforms transport errors into `McpToolError`. Both strategies are baked into the depth — the module owns "what failures look like to callers."

What to read next: the `read-aposd` chapter on deep modules (when present) carries the full conceptual treatment; here we walked the canonical instance.

A subtle judgment call worth naming: `McpClient` could in principle be split into `McpCache`, `McpRateLimiter`, `McpTransportAdapter` for "testability." That would be classitis — three classes the caller would have to compose, each with a narrow body. The current design already meets the test seam (`McpTransport` is the injection point — passing a fake transport gives full control over the integration). Splitting would widen the interface and shrink each hidden body. Don't.

## Interview defense

**Q: What makes `McpClient` a deep module rather than a thin wrapper around the SDK?**
A: The ratio. The public surface is three methods — constructor, `callTool`, `listTools` — and the body absorbs eight independent mechanics: cache, spacing gate, retry loop, retry-after parsing, error tagging, write-on-success, transport error capture, duration timing. Every caller in the codebase gets `{ result, durationMs, fromCache }` from `callTool(name, args)`, and *none* of them know about retry-after grammars, cache keys, or the 1.1-second spacing window. The grep test confirms it: search the repo for `/retry-after/` and exactly one file matches. That's the property of a real deep module — the secret lives in one place.

**Q: Walk me through what would break if you removed the spacing gate.**
A: The first burst of tool calls in any investigation would trigger the Bloomreach penalty window. `MonitoringAgent.scan` runs up to 6 tool calls; without the 1100ms gate, those six fire as fast as the network allows — probably 5 within the first second. Bloomreach returns "rate limit reached (1 per 10 second)" on call 2 onwards, and the retry loop catches it, but now every retry waits 10 seconds. A 6-call investigation that would have taken ~7 seconds (6×1.1s) now takes ~50 seconds and blows the route's 60s `maxDuration` budget. The spacing gate isn't optimization; it's the difference between honoring the rate limit proactively (cheap) and discovering it reactively (expensive). That's the load-bearing part most reviewers don't realize is load-bearing.

```
Interview-defense diagram — the spacing gate, why it's load-bearing

  WITHOUT spacing                            WITH spacing
  ┌─ t=0 ─┐                                  ┌─ t=0 ─┐
  │ call1 │ → 200ms                           │ call1 │ → 1100ms gate
  │ call2 │ → 250ms (penalty triggers)        │ call2 │ → 2200ms gate
  │ call3 │ → 10250ms (waiting on retry)      │ call3 │ → 3300ms gate
  │ call4 │ → 20250ms                          │ call4 │ → 4400ms
  │ call5 │ → 30250ms                          │ call5 │ → 5500ms
  │ call6 │ → 40250ms (route times out)        │ call6 │ → 6600ms ✓
  └────────                                   └─ done within budget ─┘
       BAD: penalty window drives the run     GOOD: spacing keeps under the limit
```

## See also

- `audit.md` — the deep-vs-shallow-modules lens now names the **DataSource seam** as the new top deep-module case study; `BloomreachDataSource` is the deepest single class. The deep walk on the seam lives in the audit lens itself.
- `02-shallow-module-page-component.md` — RESOLVED; the opposite shape worked example.
- `03-insight-anomaly-silent-leak.md` — RESOLVED; the leak that failed the same hiding test `BloomreachDataSource` passes.
- `04-synthesize-recovery-duplication.md` — RESOLVED; the prediction in the original file came true — the recovery was absorbed into `runAgentLoop` the same way rate-limit retries are absorbed into `BloomreachDataSource`.

---
