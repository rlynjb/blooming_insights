# I/O, network, and database bottlenecks

**Industry name(s):** I/O profile · network bottleneck · external-service latency · streaming I/O
**Type:** Industry standard · Language-agnostic

> blooming insights makes **two kinds of I/O calls** — HTTPS to Bloomreach MCP (data) and HTTPS to Anthropic (reasoning) — and produces **one kind of I/O out** — NDJSON over a chunked `ReadableStream` to the browser (`app/api/agent/route.ts:131-139`, `app/api/briefing/route.ts:97-143`). There is **no database**, **no Redis**, **no message queue**. The only filesystem I/O is `readFileSync` for prompts at module import (cold-start cost), the dev-mode `.investigation-cache.json` and `.auth-cache.json` (dev only — serverless FS is read-only), and the committed demo snapshots (read once per demo request). The dominant bottleneck is the **outbound HTTPS to Bloomreach**, which is rate-limited at ~1 req/s/user — every other I/O is fast by comparison.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** I/O is *anything that crosses a process boundary* — network calls, filesystem reads, database queries, queue publishes. For each, the bottleneck is some combination of *latency* (how long one operation takes), *throughput* (operations per second), and *durability* (does the operation survive a crash). Without measurement, you can only know I/O shape by reading the code: count the calls, identify the destinations, name the constraints. blooming insights' I/O shape is *narrow* — two outbound HTTPS destinations and one outbound stream — but the bottleneck is concentrated on one of them.

```
  Zoom out — where I/O happens          ← we are here (every band except UI)

  ┌─ UI (browser) ───────────────────────────────────┐
  │  fetch() to /api/briefing or /api/agent           │
  │  ReadableStream reader pulls NDJSON chunks        │
  │  no other I/O                                     │
  └──────────────────────┬────────────────────────────┘
                         │ HTTPS / chunked stream OUT
  ┌─ Route (Node serverless) ─▼───────────────────────┐
  │  ReadableStream out (writes chunks back to client)│
  │  no filesystem WRITE in prod (read-only FS)       │
  │  filesystem READ for demo snapshots               │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Module load (cold start) ─▼──────────────────────┐
  │  readFileSync of 4 prompt files (~10KB total)     │
  │  one-time cost per cold instance                  │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Provider/transport ▼─────────────────────────────┐
  │  HTTPS to Bloomreach loomi-mcp (rate-limited)     │  ★ THE BOTTLENECK
  │  HTTPS to Anthropic API (latency variance)        │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ External ──────────▼─────────────────────────────┐
  │  Bloomreach: streamable HTTP transport, ~1 req/s  │
  │  Anthropic: REST, multi-second per call           │
  │  NO DATABASE                                      │
  └───────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *what's the I/O profile of one investigation, where's the slowest hop, and what would change if a database were added?* The answer is *10-15 HTTPS calls per investigation, 6-12 of them to Bloomreach (rate-limited), 8-16 of them to Anthropic (latency-variable), one outbound NDJSON stream that runs the whole route duration, zero filesystem writes in prod, zero DB calls because there is no DB.* Below, you'll see each I/O type, the per-investigation call profile, the streaming pipeline that turns server-side latency into a visible-progress UX, and the absent database.

---

## Structure pass

**Layers.** Three I/O layers cut across the bands: *outbound network* (the providers), *outbound streaming* (NDJSON to browser), and *filesystem* (mostly absent in prod).

**Axis: latency contribution.** Hold one question constant across every I/O destination: *how much of one investigation's latency does this destination own?* This is the right axis because file 03 already established that latency is a sum of serialized waits — this file's job is to attribute that latency to each I/O hop. Cost (file 01) and visibility (file 02) sit one altitude up; latency contribution makes the per-hop ranking pop.

**Seams.** Two load-bearing.

- **IO1: rate-limited ↔ latency-variable.** Bloomreach has a *known* per-call cost — ~1.1s spacing floor + 0.5-2.5s network + server time. Anthropic has an *unknown* per-call cost — typically 3-10s but with no upper bound from the contract. Two different constraints; two different optimization paths.
- **IO2: persistent ↔ transient.** Every I/O in this system is *transient* (request-scoped). There's no database write, no event log, no audit trail — once the stream closes, the work is gone (except the in-memory `Map`s in `lib/state/`, which die with the function instance). Crossing this seam (adding a database) would change which I/O dominates and what the failure modes look like.

```
  Structure pass — I/O

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  Outbound network · Outbound streaming · Filesystem│
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  latency contribution: how much of one            │
  │  investigation's wait does this I/O own?          │
  └────────────────────────┬─────────────────────────┘
                           │  trace it across destinations
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  IO1: rate-limited ↔ latency-variable             │
  │       (Bloomreach 1 req/s · Anthropic variance)   │
  │  IO2: persistent ↔ transient                     ★│
  │       (no DB; every I/O is request-scoped)        │
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks each I/O type, the per-investigation profile, and the absent database.

---

## How it works

### Move 1 — the mental model

You've debugged a slow page by opening Chrome DevTools' Network tab and looking at the waterfall — each row is one I/O operation, the bar length is the time, the colors are connect / send / wait / receive. The whole page's load time is the longest path through that waterfall. Server-side it's the same picture, just on a different machine: each external call is one bar, the agent loop is the longest path, the total is the sum of serialized bars. blooming insights' waterfall has two destinations (Bloomreach, Anthropic) and one outbound stream, and the bars on Bloomreach are *always at least 1.1 seconds* by the spacing gate.

```
  Pattern — one investigation's I/O waterfall (serialized)

   ┌─ bootstrap ────────────────────────────────────────────────┐
   │ list_cloud_orgs    ████ (~1.5-2.5s)                          │
   │ list_projects       ████ (~1.5-2.5s)                          │
   │ get_event_schema     ████ (~1.5-3s)                            │
   │ get_customer_props    ████ (~1.5-3s)                            │
   │ list_catalogs          ████ (~1.5-3s)                            │
   │ get_project_overview    ████ (~1.5-3s)                            │
   └──────────────────────────────────────────────────────────────┘
   ┌─ diagnostic ───────────────────────────────────────────────┐
   │ Anthropic turn 1     ██████████ (3-10s)                       │
   │ MCP tool 1            ████ (~1.5-3s)                           │
   │ Anthropic turn 2       ██████████ (3-10s)                       │
   │ MCP tool 2              ████ (~1.5-3s)                           │
   │ ... ×4-6 calls ...                                              │
   │ forced synthesis (Anthropic, no tools)  ██████████ (5-10s)      │
   └──────────────────────────────────────────────────────────────┘
   ┌─ recommendation ───────────────────────────────────────────┐
   │ ... same shape, fewer calls ...                              │
   └──────────────────────────────────────────────────────────────┘

   meanwhile (concurrent, NOT contributing to investigation latency):
   NDJSON chunks out  →  →  →  →  →  →  →  →  →  →  (continuous, light)
```

The model is: **every external call is one bar on a serial waterfall**. There's no parallel HTTPS; there's no pipelined batch. The total investigation length is the sum of all bars, plus the spacing-gate floor on Bloomreach. The outbound NDJSON stream is *concurrent* with all of this — it doesn't add latency, it just lets the UI see progress as it happens.

---

### Move 2 — the four I/O types, one at a time

#### Move 2.1 — outbound HTTPS to Bloomreach (the bottleneck)

The Bloomreach MCP server is reached via the SDK's `StreamableHTTPClientTransport` (`lib/mcp/connect.ts:71`). Each call is one HTTPS POST to `https://loomi-mcp-alpha.bloomreach.com/mcp/`, carrying the tool name + arguments, returning the structured result.

```
  Pattern — Bloomreach HTTPS call (one tool call)

   wait at spacing gate:  0-1100 ms (depends on prior call's end)
        │
        ▼
   HTTPS POST to https://loomi-mcp-alpha.bloomreach.com/mcp/
        │
        │  TLS: handshake reused (keep-alive) — first call pays ~100-300ms
        │  Headers: Bearer token (from BloomreachAuthProvider)
        │  Body: JSON-RPC for the tool call
        ▼
   Bloomreach receives, executes (EQL query takes 100ms-2s server-side)
        │
        ▼
   Response: structured JSON envelope ({ structuredContent } or { content[].text })
        │
        ▼
   parsed by McpTransport → returned to McpClient
        │
        └─ cached for 60s (lib/mcp/client.ts:144)
           emitted as tool_call_end event (lib/mcp/events.ts)

   per-call total:  ~1.5-3s typical (spacing + network + server)
                    ~13-23s if rate-limited (retry waits)
   per-investigation Bloomreach calls:  ~10-15 (bootstrap + 2 agents)
   per-investigation Bloomreach time:   ~15-45s typical
```

The boundary: **the spacing gate is the dominant per-call cost on a fast Bloomreach response**. If Bloomreach returns in 200ms but the spacing gate makes you wait 1100ms first, your call took 1.3s — and 1.1s of that was "compliance with the rate limit." That's *not* wasted time per se (it prevents 429s), but it means the latency floor is set by the spacing, not by Bloomreach's actual speed.

#### Move 2.2 — outbound HTTPS to Anthropic (the variance source)

The Anthropic API is reached via `new Anthropic({ apiKey })` (`app/api/agent/route.ts:207`) and `anthropic.messages.create(...)` per call. Each call is one HTTPS POST to `https://api.anthropic.com/v1/messages`.

```
  Pattern — Anthropic HTTPS call (one model turn)

   HTTPS POST to https://api.anthropic.com/v1/messages
        │
        │  TLS: keep-alive across calls in the same process
        │  Headers: x-api-key (from env)
        │  Body: { model, max_tokens, system, messages[], tools? }
        │         ↑ messages array grows per turn (cf. file 04)
        ▼
   Anthropic queues, runs sonnet, returns
        │
        │  TYPICAL: 3-10s per call
        │  VARIANCE: server load, prompt size, output length
        │  NO contract for upper bound
        ▼
   Response: { content: [TextBlock | ToolUseBlock], usage: {...} }
        │
        └─ res.usage is NOT logged (cf. file 02)
           response is parsed by runAgentLoop; tool_use blocks dispatched

   per-call total:  ~3-10s typical (cannot be sped up — external)
   per-investigation Anthropic calls:  ~8-16 (across diagnose + recommend)
   per-investigation Anthropic time:   ~30-100s typical
```

The boundary: **Anthropic latency variance is the wildest variable in the system**. Bloomreach is bounded (spacing + network + EQL); Anthropic is bounded only by Anthropic's internal queueing. On a quiet day, an agent finishes in 30s; on a busy day, in 80s. There's no client-side control — only the `maxToolCalls` budget caps the *count* of calls, not the *time per call*.

#### Move 2.3 — outbound NDJSON streaming (the progress channel)

The route handlers return a `ReadableStream<Uint8Array>` (`app/api/agent/route.ts:169`, `app/api/briefing/route.ts:178`). Each emitted event is one NDJSON line written to the stream's controller.

```
  Pattern — outbound NDJSON streaming

   route handler:
     const stream = new ReadableStream<Uint8Array>({
       async start(controller) {
         const send = (e: AgentEvent) => {
           controller.enqueue(encoder.encode(encodeEvent(e)));  ← one line per event
         };
         // ... run agent, emit progress events as they happen ...
         send({ type: 'done' });
       },
     });
     return new Response(stream, { headers: NDJSON_HEADERS });

   wire: HTTP/1.1 chunked transfer encoding
         Content-Type: application/x-ndjson; charset=utf-8
         Cache-Control: no-cache, no-transform

   client:
     const reader = res.body.getReader();
     for (;;) { const { done, value } = await reader.read(); ... }
     buf.split('\n') → JSON.parse each line

   per-investigation events:  ~100-200 NDJSON lines
   per-event size:            ~200 bytes - 4KB (truncated)
   per-investigation bytes out: ~50KB - 500KB
```

The boundary: **streaming is the trick that hides server-side latency**. Without it, the user waits 100s and then sees everything. With it, the user sees the first event in ~1-2s (the first `stepFor('reading the workspace schema…')` before bootstrap completes — `app/api/agent/route.ts:198-201`) and the progress builds visibly. Same wall-clock time, dramatically different UX. The cost is one extra ~200-byte HTTP chunk per event; the benefit is the difference between "frozen page" and "visible work."

#### Move 2.4 — filesystem I/O (mostly cold-start cost)

Filesystem reads happen in three places:

```
  Pattern — filesystem I/O

   1. Module-import readFileSync (per agent's prompt)
      lib/agents/diagnostic.ts:14    readFileSync(prompts/diagnostic.md)
      lib/agents/monitoring.ts:13    readFileSync(prompts/monitoring.md)
      lib/agents/recommendation.ts:14 readFileSync(prompts/recommendation.md)
      lib/agents/query.ts:13         readFileSync(prompts/query.md)

      runs once at module load (cold start cost)
      ~few ms per file × 4 files = ~10-20ms cold start contribution

   2. Demo snapshot reads (when ?demo=cached)
      app/api/briefing/route.ts:87   readFileSync(lib/state/demo-insights.json)
      app/api/agent/route.ts:53      readFileSync(lib/state/demo-insights.json)
      lib/state/investigations.ts:23 readJson(lib/state/demo-investigations.json)

      runs per demo request; sync read of ~50-200KB JSON
      ~5-20ms per read

   3. Dev-mode persistence (NODE_ENV === 'development')
      lib/state/investigations.ts:32  writeFileSync(.investigation-cache.json)
      lib/mcp/auth.ts:138             writeFileSync(.auth-cache.json)

      runs per investigation save (dev only)
      ~5-20ms per write
      ★ NO-OP in production (serverless FS is read-only)
```

The boundary: **filesystem I/O is invisible in production**. Module-load reads happen once per cold start; demo reads only on `?demo=cached`; writes don't happen at all (the `PERSIST` flag is `false` in production). The filesystem is not a bottleneck in production — it's a dev-mode convenience.

---

### Move 3 — the absent database

There's no PostgreSQL, no Redis, no DynamoDB, no SQLite. The closest thing to a database is the encrypted `bi_auth` cookie (`lib/mcp/auth.ts:46-104`), which holds OAuth state across the connect/callback flow. Every other "persisted" thing is either in-memory (the `Map`s) or committed JSON (the demo snapshots).

```
  Pattern — what a database would change

   today:                                  with a database:
   ────────                                ─────────────────
   insights: Map<id, Insight>              insights_table
     (in-memory, per-instance)               (durable, cross-instance, cross-deploy)
     lost on cold start                      survives cold start
     lost on instance death                  survives instance death
     two instances see DIFFERENT data        all instances see SAME data
     no race protection                      transaction guarantees

   investigations: Map<id, events>          investigations_table
     (in-memory, grows in warm instance)     (durable, queryable, paginatable)
     no history beyond current process       history across time

   feedback: not stored                      feedback_table
                                             user feedback on diagnoses survives

   audit: not stored                         audit_log_table
                                             "who ran what query when" survives

   I/O contribution today:        I/O contribution WITH database:
   0 ms                            +5-50ms per query (network to DB)
                                   +write latency per save (~10-20ms)
                                   +durability + horizontal scale + history
```

The deliberate absence is the load-bearing architectural choice (cf. `study-system-design/00-overview.md`). It buys *deploy simplicity* (no schema migrations, no connection pools, no DB credentials) and *zero-latency state access* (Map lookups are nanoseconds). It costs *durability* (cold start wipes state) and *cross-instance consistency* (two warm instances see different feeds).

---

## Primary diagram

The full I/O picture — every destination, every direction, every constraint.

```
  blooming insights — the I/O landscape

  ┌─ Browser ──────────────────────────────────────────────────────────────┐
  │  fetch /api/briefing or /api/agent      (outbound HTTPS)               │
  │  ReadableStream reader (inbound chunks)                                │
  │  NO localStorage I/O for state — uses sessionStorage (synchronous)    │
  └────────────────────────────────┬───────────────────────────────────────┘
                                   │ HTTPS / chunked NDJSON
  ┌─ Vercel serverless function ───▼───────────────────────────────────────┐
  │                                                                         │
  │  IN:    one HTTP request (with cookies, query params)                  │
  │  OUT:   one chunked NDJSON stream (continuous until done)              │
  │                                                                         │
  │  ┌─ Filesystem (mostly cold start) ──────────────────────────────────┐ │
  │  │  readFileSync × 4 prompts (~10-20ms cold start)                   │ │
  │  │  readFileSync demo-insights.json (only ?demo=cached)              │ │
  │  │  writeFileSync .investigation-cache.json (DEV ONLY)               │ │
  │  └────────────────────────────────────────────────────────────────────┘ │
  │                                                                         │
  │  ┌─ Outbound HTTPS ──────────────────────────────────────────────────┐ │
  │  │                                                                    │ │
  │  │  ★ Bloomreach loomi-mcp ────────────────────────────────────────  │ │
  │  │  POST /mcp/  (one per tool call)                                  │ │
  │  │  ~10-15 calls per investigation                                   │ │
  │  │  ~1.5-3s per call typical (spacing + network + EQL)               │ │
  │  │  ~13-23s per call if rate-limited (retry)                         │ │
  │  │  Rate cap: ~1 req/s/user GLOBAL  ★ THE BOTTLENECK                 │ │
  │  │                                                                    │ │
  │  │  ★ Anthropic ────────────────────────────────────────────────────  │ │
  │  │  POST /v1/messages  (one per turn)                                │ │
  │  │  ~8-16 calls per investigation                                    │ │
  │  │  ~3-10s per call typical, NO upper bound from contract            │ │
  │  │  res.usage returned but NOT logged                                │ │
  │  └────────────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─ DOES NOT EXIST in this codebase ──────────────────────────────────────┐
  │  Database (Postgres, MySQL, SQLite, DynamoDB)                          │
  │  Cache server (Redis, Memcached)                                       │
  │  Message queue (SQS, Kafka, RabbitMQ)                                 │
  │  Object store (S3, GCS)  (other than the `bi_auth` encrypted cookie)  │
  │  CDN-cached API responses (Cache-Control: no-cache, no-transform)     │
  └─────────────────────────────────────────────────────────────────────────┘

  PER-INVESTIGATION I/O TIME ATTRIBUTION:
    Bloomreach:    ~15-45s   (10-15 calls × ~1.5-3s)
    Anthropic:     ~30-100s  (8-16 calls × ~3-10s)
    NDJSON out:    ~negligible (interleaved with above, no extra latency)
    Filesystem:    ~0 in prod (no writes; reads only at module load)
    Database:      0 (does not exist)
```

---

## Implementation in codebase

### Use cases — where each I/O type appears

- **Bloomreach HTTPS** — every `McpClient.callTool` invocation. Bootstrap fires 4 (event schema, customer props, catalogs, overview) + 2 (list orgs, list projects). Each agent fires 0-6 EQL/profile queries.
- **Anthropic HTTPS** — every `anthropic.messages.create`. The agent loop fires 1 per turn (up to 8 turns). The intent classifier fires 1 per query. The synthesize fallbacks fire 1 each when the loop fails to parse.
- **NDJSON streaming out** — every `controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))` inside the `ReadableStream.start`. ~100-200 events per investigation.
- **Filesystem reads** — `readFileSync` at module top-level for prompts (cold start); demo JSON for replay mode; dev cache files for development persistence.
- **No database** — by deliberate architectural choice; cookie + in-memory Maps + committed JSON cover the demo product.

### Code side by side

**The Bloomreach HTTPS call — wrapped in spacing + retry + cache.**

```
  lib/mcp/client.ts  (lines 97–146, abbreviated)

  async callTool<T = unknown>(name: string, args, options): Promise<CallToolResult<T>> {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
    const ttl = options.cacheTtlMs ?? 60_000;

    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result, durationMs: 0, fromCache: true };  ← I/O SKIPPED
      }
    }

    const start = Date.now();
    let result = await this.liveCall(name, args);                            ← actual HTTPS
        │
        │  (inside liveCall:)
        │   - sleep until spacing gate clears (~0-1100 ms)
        │   - POST to Bloomreach
        │   - parse response or catch error
        │
    while (isRateLimited(result) && retries < this.maxRetries) {
      // ... wait + retry ...
      result = await this.liveCall(name, args);                              ← retry HTTPS
    }
    // ... cache + return ...
  }
        │
        └─ THREE I/O optimizations layered on the call: cache (skip entirely),
           spacing (avoid 429), retry (recover from 429). Without them, every
           call would be a raw HTTPS POST to a rate-limited server.
```

**The Anthropic HTTPS call — the agent loop's main turn.**

```
  lib/agents/base.ts  (line 102)

  const res = await anthropic.messages.create(params);     ← THE Anthropic call
        │
        └─ this is the heaviest per-call I/O in the system. params includes
           the full messages[] array (which grows per turn — see file 04),
           the system prompt (~5-10KB), and the tools schema (~5-15KB on
           the agent's tool subset). The response carries the model's
           content blocks plus res.usage (free, unused).
           NO timeout configured — relies on Anthropic SDK defaults.
           NO retry on transient failure — a single failed call throws
           and the agent loop catches at the top (the catch in the route).
```

**The NDJSON outbound stream — the progress channel.**

```
  app/api/agent/route.ts  (lines 167–264, abbreviated)

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const collected: AgentEvent[] = [];
      const send = (e: AgentEvent) => {
        collected.push(e);                                              ← keep for cache
        controller.enqueue(encoder.encode(encodeEvent(e)));             ← write one NDJSON line
      };
      // ... agent runs, calling send(...) for every reasoning_step, tool_call,
      //     tool_result, diagnosis, recommendation event ...
      send({ type: 'done' });
      if (step == null) saveInvestigation(insightId!, collected);
    },
  });

  return new Response(stream, { headers: NDJSON_HEADERS });
        │
        └─ THE outbound I/O channel. Every event is one chunk on the wire.
           Cache-Control: no-cache, no-transform (NDJSON_HEADERS) ensures
           no intermediary (CDN, proxy) buffers the stream — chunks arrive
           in real time. Without no-transform, gzip middleware could
           buffer until the response ends, defeating the streaming.
```

**Filesystem read at module load — paid once per cold start.**

```
  lib/agents/diagnostic.ts  (line 14)

  const PROMPT = readFileSync(join(process.cwd(), 'lib/agents/prompts/diagnostic.md'), 'utf8');
        │
        └─ runs at module import time, NOT per request. The prompt file
           (~3-5KB) is read once into a module-level constant. Every
           agent uses readFileSync exactly this way (monitoring,
           diagnostic, recommendation, query). Total cold-start FS
           cost: ~4 files × ~few ms = ~10-20ms.

           NOTE: readFileSync is sync. In a hot path this would block
           the event loop, but in module load it's fine — the module
           isn't yet serving requests.
```

**The dev-only filesystem write — bypassed in production.**

```
  lib/state/investigations.ts  (lines 7–41, abbreviated)

  const PERSIST = process.env.NODE_ENV === 'development';       ← prod guard
  const CACHE_FILE = join(process.cwd(), '.investigation-cache.json');

  export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
    mem.set(insightId, events);                                  ← always (in-memory)
    if (PERSIST) {                                               ← DEV ONLY
      const all = readJson(CACHE_FILE);
      all[insightId] = events;
      try {
        writeFileSync(CACHE_FILE, JSON.stringify(all));
      } catch {
        /* best effort */
      }
    }
  }
        │
        └─ in production, this function is just `mem.set(insightId, events)`
           — purely in-memory. The Vercel serverless FS is read-only;
           writeFileSync would throw EROFS. The PERSIST guard is what
           keeps the same code working in both environments.
```

---

## Elaborate

**Where this pattern comes from.** "Network I/O dominates in distributed systems" is a truism that holds in nearly every web app — the local CPU is so much faster than any network round-trip that the only thing that matters is *how many round-trips you make* and *how long each one takes*. blooming insights is a clean example of the pattern: zero local CPU pressure, ~10-15 Bloomreach round-trips, ~8-16 Anthropic round-trips, and everything else is interleaved or free. The classic optimizations — caching to skip a round-trip, batching to amortize, prefetching to overlap — show up exactly where you'd expect (cache yes, batching no, prefetching N/A for this shape).

**Why streaming the response matters more than batching the requests.** Streaming changes *perceived* latency (the user sees progress); batching changes *actual* latency (fewer round-trips). For blooming insights, the round-trips can't be batched (Bloomreach has no batch endpoint, Anthropic's `messages` API is one-turn-per-call). So the only lever for *actual* latency is the cache (which removes round-trips entirely). The only lever for *perceived* latency is streaming, which the system uses aggressively — every `reasoning_step` event is one line on the wire, the UI updates the moment it arrives.

**Why no database is the load-bearing decision.** The absence of a database means every "save" is in-memory (the Maps in `lib/state/`) and every "load" is from the same in-memory Maps (or the demo JSON, or sessionStorage on the client). This buys *zero I/O latency for state operations* and *zero deploy complexity* (no migrations, no connection pools, no credentials). It costs *durability* (cold start wipes state) and *cross-instance consistency* (file 06 of `study-system-design` walks the bottleneck this creates at 10x users). For demo scale, the trade is right; for production scale, file 07 of `study-system-design` ranks "no database" as the second ceiling that breaks.

**Connection to adjacent concepts.** File 03 covers the latency math; this file attributes it to specific I/O destinations. File 06 covers the cache that removes I/O entirely. File 04 covers the memory shapes that hold state in the absence of a database. `study-system-design/05-storage-choice-and-durability-boundaries.md` covers the "no DB" architectural choice in depth.

---

## Interview defense

### Q: What's the slowest hop in a blooming insights investigation, and how do you know?

**Answer:** The Bloomreach HTTPS call, by call count and rate-limit contract. Each Bloomreach call is at *least* 1.1 seconds (spacing gate) and a typical investigation makes 10-15 of them — so 15-45 seconds of pure Bloomreach time. Anthropic calls are individually slower (3-10s vs 1.5-3s) but unconstrained — they're "wait time" not "throttled time." The honest answer is that Anthropic owns more *total* wall-clock per investigation (~60% of typical latency), but Bloomreach owns the *throttle* — without the spacing gate, we'd burn through the rate limit and the retry waits would dominate. The bottleneck is Bloomreach for *structure*; Anthropic for *minutes spent*.

```
  per-investigation I/O time attribution (typical)

   Bloomreach:    ~25%  (15-45s of ~100s)
   Anthropic:     ~60%  (30-100s of ~100s)
   FS / NDJSON:   ~0%   (interleaved, negligible)
   DB:            0%    (does not exist)

   structural bottleneck:  Bloomreach (rate limit caps throughput)
   minutes spent:           Anthropic (latency variance, unmeasured)
```

### Q: There's no database — what's the I/O cost of that decision today, and what would change with one?

**Answer:** Today, "I/O cost of no database" is *negative* — adding one would add 5-50ms per query (network to DB) plus durability/migration cost. The state lookups today (the in-memory Maps) are nanoseconds. The cost shows up at *scale*, not in I/O: cold start wipes state, two warm instances see different data, no history beyond current process. Adding a database would *increase* I/O per investigation (~50-200ms total for save + retrieval) but *decrease* the architectural failure modes. The trade today is right for demo scale; file 07 of `study-system-design` walks where it breaks.

```
  no-DB trade

   today                            with a DB
   ─────                            ─────────
   I/O: 0 ms state ops              I/O: +50-200 ms per investigation
   architecture: simple             architecture: + connection pool, migrations
   durability: cold-start wipes     durability: survives everything
   scale: per-instance              scale: cross-instance shared state
```

### Q: Why doesn't the NDJSON streaming add latency to the investigation?

**Answer:** Because it's *interleaved* with the wait, not *added to* it. While the agent is waiting on Anthropic to respond (3-10s), the route already wrote earlier events to the stream — those bytes are already on the wire, being parsed by the browser. The stream doesn't wait for anything to flush; `controller.enqueue` is synchronous and buffer-backed (the Web Streams API). The only cost is per-event bytes (~200-4KB each × 100-200 events = ~50-500KB total per investigation), which on a chunked HTTP connection is negligible. The win is perceptual: the user sees the first event in ~1-2s, watches activity build, and reads the diagnosis as soon as the agent emits it — instead of staring at a spinner for 100s.

---

## Validate

**Level 1 — Reconstruct.** Name the four I/O types in blooming insights and the destination/direction of each. (Answer: outbound HTTPS to Bloomreach (one per MCP tool call); outbound HTTPS to Anthropic (one per agent turn); outbound chunked NDJSON to the browser (continuous during a route invocation); filesystem reads at module import (prompts) + demo snapshot reads (only on `?demo=cached`). No filesystem writes in production. No database.)

**Level 2 — Explain.** Why is "Bloomreach is the bottleneck" both true and incomplete? (Answer: Bloomreach is the *structural* bottleneck because its ~1 req/s/user rate limit caps throughput regardless of any speedup elsewhere — you can't parallelize MCP calls without breaking the rate limit. But Anthropic owns *more* of the per-investigation wall-clock time (~60% vs Bloomreach's ~25%) because each Anthropic call is 3-10s vs Bloomreach's 1.5-3s. The bottleneck is *Bloomreach* for "what limits scale," *Anthropic* for "what costs us time today.")

**Level 3 — Apply.** A new feature wants to log every diagnosis to a "feedback DB" so users can rate them. What I/O does this add per investigation, and where would the write land? (Answer: one DB write per diagnosis (~10-50ms depending on DB latency). The natural landing spot is the route's `send({ type: 'diagnosis', diagnosis })` call (`app/api/agent/route.ts:239`) — right after the diagnosis is emitted to the stream. The cost is small relative to the ~100s investigation, but it introduces the *first* DB dependency in the codebase — connection pool, migrations, credentials, failure mode if the DB is down. That last point is the architectural cost: today the system has zero DB-down failure modes; adding one DB write adds one.)

**Level 4 — Defend.** A reviewer says "the spacing gate is adding 6-12 seconds of latency per investigation — remove it." Defend. (Answer: removing it means the second call hits Bloomreach 200ms after the first, which exceeds "1 per second" and returns a 429 with a 10-second retry hint. The retry wait (parsed from the error) is ~10s. So removing the spacing gate trades 1.1s of *deterministic* wait for ~10s of *retry-conditional* wait. On every call. Net effect: ~10× more latency in the failure mode, with the rate-limit budget burned. The spacing gate is the *cheaper* compliance with the rate limit; removing it makes things worse, not better. The real lever is the cache (which removes the call entirely) or upgrading the Bloomreach plan (which moves the rate ceiling).)

---

## See also

- `01-performance-budget.md` — the spacing-gate floor is Budget 4
- `03-latency-throughput-and-tail-behavior.md` — the per-call latency math
- `06-caching-batching-and-backpressure.md` — the cache that removes Bloomreach round-trips entirely
- `08-performance-red-flags-audit.md` — Anthropic latency variance as an unmeasured risk
- `.aipe/study-system-design/05-storage-choice-and-durability-boundaries.md` — why there's no DB
- `.aipe/study-networking/` (sibling guide) — HTTPS, chunked transfer, TLS reuse from a transport lens
