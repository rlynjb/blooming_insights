# Distributed System Map

*Industry name: coordination map / topology diagram · Type: Language-agnostic*

## Zoom out — where this concept lives

Every distributed-systems audit opens with a picture: what participants exist, which arrows carry messages, who owns what state, and where the trust boundaries are. Without that picture, the rest of the vocabulary — timeouts, retries, quorums, sagas — has nothing to attach to. Here's the whole system, one frame:

```
  Blooming insights coordination map — three bands, one hop out

  ┌─ Client band (browser) ────────────────────────────────┐
  │  Next.js UI  ·  SSE reader  ·  localStorage             │
  │  state owned: bi:mcp_config, bi:mode, sessionStorage    │
  └───────────────────────┬────────────────────────────────┘
                          │  HTTPS · SSE / NDJSON
                          │  headers: x-bi-mcp-config, bi_session cookie
  ┌─ Server band (Vercel function, ephemeral) ─────────────┐
  │  ★ THIS BAND CROSSES THE DISTRIBUTED SEAM ★             │
  │  app/api/agent · app/api/mcp/*  (maxDuration=300)       │
  │  state owned: 60s response cache (per instance)         │
  │                encrypted auth cookie (per session)      │
  │                in-mem investigations (per instance)     │
  │                per-request AsyncLocalStorage auth store │
  └───────────────────────┬────────────────────────────────┘
                          │  HTTPS · streamable-http MCP
                          │  auth: OAuth 2.1 / Bearer / none
  ┌─ External band ───────▼────────────────────────────────┐
  │  MCP server  (one URL per request)                     │
  │  state owned: whatever the tool exposes                │
  │  default preset: Bloomreach loomi                      │
  │  parallel path: Anthropic API (not shown; own hop)     │
  └────────────────────────────────────────────────────────┘
```

This is the concept. Notice what's NOT here: no replicas, no partitions, no message broker, no leader, no gossip protocol, no service mesh. Everything sits on one axis — the HTTPS hop from the Vercel function to the MCP server.

## Zoom in — narrow to the concept

The coordination map answers one question: "when someone says the system fails, which participant and which arrow are they talking about?" You can't reason about a failure until you can point to the arrow it fires on. In this repo the vocabulary is small: `client → server` and `server → MCP server`. That's it. The audit files that follow can be precise because the map is small.

## Structure pass

The map has three layers, one axis worth tracing across all of them, and two seams that carry contracts. Reading the skeleton in that order tells you where the mechanics belong.

### Layers

- **Client** — browser, Next.js UI, `localStorage`. Chooses which MCP server to talk to (see `lib/mcp/config.ts:34`).
- **Server** — Vercel function, `app/api/agent/route.ts`. Owns the agent loop and the DataSource port.
- **External** — MCP server (default: Bloomreach), plus Anthropic on a separate hop.

### One axis held constant — "who owns the state?"

```
  Axis: state ownership, traced across the three layers

  client        →  UI settings (bi:mcp_config),
                    bi_session cookie value
                    → survives navigation, is durable per browser

  server        →  60s response cache (per instance),
                    in-mem investigations (per instance),
                    encrypted auth cookie (per request)
                    → durable per instance, ephemeral across scale-out

  external      →  whatever the tool exposes (Bloomreach event log,
                    project metadata) — this repo doesn't own it
                    → durable per tenant, unmanaged by us

  the answer flips at every layer — three different owners,
  three different durability profiles
```

The interesting flip is between "durable per browser" (client) and "durable per instance, ephemeral across scale-out" (server). That flip is where most of the risk lives — a browser expects state to survive, and a Vercel function can't promise that.

### Seams — where the axis-answer flips

- **The HTTPS boundary between client and server.** State ownership flips from "browser durable" to "instance ephemeral." That's why the auth cookie exists: it moves durable state back into the browser so any Vercel instance can decrypt it. See `lib/mcp/auth.ts:86` `withAuthCookies` — one read at request start, one write at request end, AsyncLocalStorage in between.

- **The DataSource port** (`lib/data-source/types.ts:63`). State ownership flips from "server code" to "external service." This is the seam where the retry ladder, the spacing gate, the 30 s timeout, and the fault injector all attach. Same interface, different failure profile on either side.

The MCP server URL is *data* now (Session B/C), not part of the codebase identity. Bloomreach is one preset; a different URL means a different tenant, but the same DataSource contract.

## How it works

### Move 1 — the mental model

Think of the coordination map as a graph where **nodes are participants** and **edges are RPCs that can fail independently**. You've built one of these before — every `fetch()` you've written is an edge, and every server that handles it is a node. Same primitive; just draw it out.

```
  The pattern: nodes + directed edges + failure independence

     ●────────────►●
     browser       Vercel function
                       │
                       ▼
                    ●────────►●
                    MCP        Anthropic
                    server     API

  every arrow can fail without the others firing —
  independence is the property that makes it distributed
```

The kernel is **failure independence**: any arrow can drop or delay without the others noticing. If the arrows fired together (one process, one call stack) it wouldn't be distributed — it'd be one system. The instant an arrow can fail on its own, coordination starts.

### Move 2 — the walkthrough

Walk the map one participant at a time, top to bottom, naming what each one owns.

#### The client (browser)

The browser holds durable state that the server can't. Two pieces matter:

- `bi_session` cookie — set by `getOrCreateSessionId()` in `lib/mcp/session.ts:16`. It's the identity that keys the auth store (`lib/mcp/auth.ts:12` `SessionAuthState`).
- `localStorage[bi:mcp_config]` — the UI settings override. Read by `readPersistedConfig()` (`lib/mcp/config.ts:106`) and encoded into a base64 header on every fetch (`persistedConfigHeader()` at line 142).

Nothing in the client "coordinates" with the server — it just supplies inputs and reads the stream. But the client is the ONLY participant that stably holds state across Vercel scale-out. That matters when the auth cookie backend is the encrypted cookie (see the seam below).

```
  Client → server hop

  ┌─ Browser ───────┐     hop: HTTPS GET /api/agent
  │  fetch(         │ ────────────────────────────►
  │   '/api/agent', │     headers:
  │   { headers: {  │       x-bi-mcp-config: <base64>
  │     'x-bi-mcp-  │       cookie: bi_session=<uuid>, bi_auth=<enc>
  │      config':.. │
  │   }})           │     body: NDJSON stream (SSE-shaped)
  └─────────────────┘ ◄────────────────────────────
```

#### The server (Vercel function)

The entry point is `app/api/agent/route.ts`. Two properties dominate:

- **Ephemeral**. `maxDuration = 300` (line 23). Each request lives at most 300 s in a single instance. Scale-out means any request can hit any instance.
- **Composed AbortSignals**. `req.signal` is threaded down through `bootstrap → listTools → agent.investigate → dataSource.callTool → transport.callTool`. See the receive path at `route.ts:231` `req.signal.throwIfAborted()`. Every layer respects the cancel.

The instance-local state is the interesting part. **The 60 s response cache** (`lib/data-source/bloomreach-data-source.ts:122`) is a `Map` on the class instance — one instance per active tenant, per function process. On scale-out the cache is empty. **The investigations cache** (`lib/state/investigations.ts:11`) is a top-level `Map` — same story. The route handler treats these as opportunistic hits, not correctness guarantees.

The trust boundary sits at the function's public HTTPS surface. Anything client-supplied — the `x-bi-mcp-config` header, `?insight=` param — is validated with a fail-safe (`isMcpConfigOverride`, `decodeConfigHeader` returns null on garbage; the resolveAnomaly path silently falls back). See `lib/mcp/config.ts:87`:

```ts
// lib/mcp/config.ts:87
export function decodeConfigHeader(header: string | null | undefined): McpConfigOverride | null {
  if (!header) return null;
  try {
    const json = /* atob or Buffer */;
    const parsed = JSON.parse(json);
    if (!isMcpConfigOverride(parsed)) return null;  // ← type-guard rejects bad shape
    return normalizeConfig(parsed);
  } catch {
    return null;                                     // ← never throws; falls through to env
  }
}
```

The comment upstream (`config.ts:87`) is explicit: "do not throw — a bad header shouldn't crash the request; fall through to env instead." That's a coordination decision: a malformed client input never crosses into the server's state.

#### The external band

**The MCP server is the only true distributed participant.** It runs somewhere else, on someone else's schedule, with someone else's failure modes. The default preset is Bloomreach's loomi endpoint (`lib/mcp/connect.ts:47` `'https://loomi-mcp-alpha.bloomreach.com/mcp/'`). Any URL works; Session B/C made this a per-request value.

Three auth flows are supported behind one interface (`OAuthClientProvider`):

```
  Auth strategy per-server — same interface, different flow

  ┌─ oauth-bloomreach ────┐   3-legged OAuth 2.1 + PKCE + DCR
  │  BloomreachAuthProv.  │   state persisted per session
  │  redirectToAuth() →   │   PKCE verifier + client info survive
  │  finishAuth(code)     │   the connect→callback split
  └───────────────────────┘

  ┌─ bearer ──────────────┐   1-hop: attach Authorization: Bearer <t>
  │  BearerAuthProvider   │   token from env or per-request UI override
  └───────────────────────┘

  ┌─ anonymous ───────────┐   no auth header at all
  │  AnonymousAuthProvider│
  └───────────────────────┘

  makeAuthProvider(cfg) picks based on env + UI override
  → lib/mcp/auth-providers/index.ts:56
```

The routing is coordination-style: an incoming request carries a `x-bi-mcp-config` header, the server merges it with env defaults, `makeAuthProvider` picks the concrete implementation, and the transport is built. Nothing in the agent loop cares which auth strategy is on the wire.

**Anthropic is a separate hop.** From the agent's perspective it's a fetch to `api.anthropic.com`. It has its own failure modes (rate limits, cache hits/misses via `cache_control: { type: 'ephemeral' }` on the system prompt — `aptkit-adapters.ts:87`), but it's outside this repo's coordination map because we never wrap it in retry/timeout/spacing logic. Anthropic's SDK owns those.

#### The DataSource port — the seam the map hangs off

The whole map is legible because the coordination surface is *one interface*, and every adapter fits behind it:

```ts
// lib/data-source/types.ts:63
export interface DataSource {
  callTool(name, args, opts?): Promise<DataSourceCallResult>;
  listTools(opts?): Promise<unknown>;
}
```

Three adapters implement it: `McpDataSource` (aliased `BloomreachDataSource`), `SyntheticDataSource`, and `FaultInjectingDataSource` (a decorator). The agent loop only ever sees `DataSource`. Every distributed concern — timeout, retry, cache — sits inside the McpDataSource adapter; the agent doesn't know.

This is the seam that makes fault injection possible (Phase-4). The decorator wraps *any* DataSource, forces failures at configured rates, and the agent loop doesn't need to change to observe the faults. See `lib/data-source/fault-injecting.ts:65` `FaultInjectingDataSource` — same interface, different behavior.

### Move 3 — the principle

**A coordination map is only useful if it's honest about what's actually distributed and what isn't.** This repo's map is small: one hop out, one authenticated session, one shared cache scoped to one instance. Drawing three layers with impressive arrows would misrepresent it. Naming that the MCP server is the single distributed participant makes the retry ladder, the fault injector, and the AbortSignal composition read as exactly what they are — the surface area where correctness under partial failure has to hold.

## Primary diagram

The whole map, every arrow labelled:

```
  Blooming insights — the coordination map, one frame

  ┌─ Client band ──────────────────────────────────────────┐
  │  Browser                                                │
  │  ├─ bi_session cookie          (persistent, per-browser)│
  │  └─ localStorage[bi:mcp_config](persistent, per-browser)│
  └──────────┬─────────────────────────────────────────────┘
             │  hop 1: HTTPS  (SSE / NDJSON body)
             │  headers: x-bi-mcp-config (base64 JSON),
             │           cookie: bi_session, bi_auth (AES-256-GCM)
             ▼
  ┌─ Server band (Vercel function) ────────────────────────┐
  │  app/api/agent/route.ts  (maxDuration=300)              │
  │  ├─ 60s response cache          (per instance)          │
  │  ├─ investigations Map          (per instance)          │
  │  └─ AsyncLocalStorage auth store(per request)           │
  │  ┌─ DataSource port ──────────────────────────────┐     │
  │  │  chosen by mode + config override:             │     │
  │  │    live-mcp     → McpDataSource                │     │
  │  │    live-synth   → SyntheticDataSource          │     │
  │  │    tests/load   → FaultInjectingDataSource     │     │
  │  └────────────┬───────────────────────────────────┘     │
  └───────────────┼────────────────────────────────────────┘
                  │  hop 2: HTTPS  (streamable-http MCP)
                  │  auth: Bearer <token> · OR · OAuth cookie
                  │  timeout: AbortSignal.timeout(30_000)
                  ▼
  ┌─ External band ────────────────────────────────────────┐
  │  MCP server (URL is per-request data)                   │
  │  default preset: Bloomreach loomi-mcp-alpha             │
  │  the only true distributed participant                  │
  └────────────────────────────────────────────────────────┘

  parallel hop (not on the coordination map, own SDK owns retries):
  ┌───────────────────────────┐
  │  Anthropic API            │
  │  cache_control: ephemeral │  ← 80% input token cost cut
  └───────────────────────────┘
```

## Elaborate

The map matters most when someone reports "the system is slow." The right first question is "which arrow?" — and that only works if you drew the arrows first.

For this repo, the coordination map stays small because the product is a *single-tenant investigation tool*: one user, one browser, one MCP tenant, one investigation at a time. The map would grow if the product moved to background jobs (adds a queue arrow), multi-user persistence (adds a shared database arrow), or a multi-region deploy (adds replica arrows). See `05-replication-partitioning-and-quorums.md` and `08-sagas-outbox-and-cross-boundary-workflows.md` for what those additions would demand.

The historical arc is worth naming: an Olist SQL-backed data source used to live behind this same seam, and was retired when Synthetic proved sufficient for offline demos. **That's the seam paying off** — retiring an entire adapter didn't change the agent loop. The map got simpler by one node.

## Interview defense

**Q: "What's the coordination surface of this system?"**

A: One hop out. The Vercel function talks to an MCP server over HTTPS; that's the only participant that can fail independently of the app. Anthropic is a separate fetch but its SDK owns the retry policy, so we treat it as a leaf, not a coordinated peer.

```
   Browser ──► Vercel fn ──► MCP server
                    │
                    └──────► Anthropic (leaf)
```

**Q: "Where does state live and who owns it?"**

A: Three owners. Browser owns `bi_session` and `localStorage[bi:mcp_config]` — persistent across navigation. Server owns the 60 s response cache and in-memory investigations Map — durable per Vercel *instance*, gone on scale-out. External owns the tool data.

**Load-bearing gotcha**: on Vercel's autoscaling model, the server-owned cache is effectively empty on the first request to a new instance. Any "we already have that data" story has to be per-instance. The correctness path is the retry ladder + spacing gate, not the cache — the cache is opportunistic.

**Q: "What flips at each seam?"**

A: **Client → server** flips *state durability* (browser persistent → instance ephemeral). That flip is why the encrypted auth cookie exists — it moves durable state back to the browser so any Vercel instance can decrypt it (`lib/mcp/auth.ts:86`).

**Server → external** flips *failure ownership*. Inside the function, we control failure. Past the DataSource port, the MCP server owns its own failure profile — 429 windows, timeouts, malformed responses — and the McpDataSource adapter has to translate all of that into a shape the agent loop can reason about.

## See also

- `02-partial-failure-timeouts-and-retries.md` — what the arrow-crossing correctness actually is.
- `04-consistency-models-and-staleness.md` — how the instance-local cache behaves.
- `09-distributed-systems-red-flags-audit.md` — where this map's small size hides real risks.
