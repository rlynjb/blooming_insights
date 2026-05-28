# 01 — system design

The architectural patterns this codebase actually uses, one file per pattern. Each file walks from a frontend-primitive hook → the mechanics with diagrams → where it lives in the code → tradeoffs → interview defense → a self-check.

## Patterns

- **[01-request-flow.md](01-request-flow.md)** — how a click becomes data: feed page → `/api/briefing` → session → `connectMcp` → schema bootstrap → monitoring agent → insights → render (or a cached snapshot).
- **[02-oauth-boundary.md](02-oauth-boundary.md)** — server-side OAuth (Authorization Code + PKCE + Dynamic Client Registration) driven by the MCP SDK via a `BloomreachAuthProvider`; capture-the-redirect, callback `finishAuth`, session-keyed persistence.
- **[03-provider-abstraction.md](03-provider-abstraction.md)** — the injectable `McpTransport` / `McpCaller` seams + Anthropic-as-a-param that make the whole agent loop unit-testable with fakes and no network.
- **[04-caching-and-rate-limiting.md](04-caching-and-rate-limiting.md)** — the `McpClient` choke-point: TTL cache, ~1.1s inter-call spacing (the server allows ~1 req/s/user), bounded rate-limit retry, no-cache-on-error.
- **[05-streaming-ndjson.md](05-streaming-ndjson.md)** — `/api/agent` streams `AgentEvent`s as NDJSON over a `ReadableStream`; the browser consumes them with a `fetch` reader (not `EventSource`); cache-replay reuses the same wire format.
- **[06-multi-agent-orchestration.md](06-multi-agent-orchestration.md)** — one shared `runAgentLoop` powering four agents; a `maxToolCalls` budget + forced-final turn + a dedicated synthesis call that guarantees structured output.

## The 6-step system-design checklist

A mental walk for any system. Each pattern above is tagged with the step(s) it lives in.

```
1. Data model            — entities, shapes, where they live
2. Request / response    — how a request traverses the layers
3. Caching layers        — what's cached, where, and how it expires
4. State ownership       — who holds what, across which boundaries
5. Failure handling      — what breaks, what retries, what degrades
6. Scale concerns        — what breaks first at 10×
```

| Pattern | Checklist step(s) |
|---|---|
| 01 request-flow | **2** request/response flow |
| 02 oauth-boundary | **4** state ownership · **5** failure handling |
| 03 provider-abstraction | **2** request/response flow (underpins **5** via fakeable error injection) |
| 04 caching-and-rate-limiting | **3** caching layers · **5** failure handling · **6** scale concerns |
| 05 streaming-ndjson | **2** request/response flow · **5** failure handling |
| 06 multi-agent-orchestration | **2** request/response flow · **5** failure handling · **6** scale concerns |

> Note: there is no classic relational **data model** (step 1) here — state is in-memory maps + committed JSON snapshots, no DB. That absence is itself a design decision; see `04-caching-and-rate-limiting.md` and `02-oauth-boundary.md` for where state lives and what that costs at scale.
