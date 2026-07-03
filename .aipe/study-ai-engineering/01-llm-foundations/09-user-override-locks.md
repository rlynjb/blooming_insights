# User-override discipline

## Subtitle

Per-request configuration override / user-controlled model surface — Project-specific.

## Zoom out, then zoom in

This codebase has a subtle version of the "user override" pattern. There's no per-field `_overridden_at` lock (the classic pattern from productivity-app LLM features), because no data written by the LLM re-runs against user-edited state. What the codebase *does* have: a **per-request MCP config override** where the user (via a settings modal) can point the agents at their own MCP server, their own auth token, their own workspace. That's user control over the substrate the agents run against, which is functionally the same discipline: the code checks for a user override before defaulting.

```
  Zoom out — where user override sits

  ┌─ UI: settings modal ─────────────────────────────────┐
  │  writes JSON to localStorage[BI_MCP_CONFIG_KEY]      │
  └───────────────────────┬──────────────────────────────┘
                          │  encoded into HTTP header on every fetch
                          ▼
  ┌─ Route handler ─────────────────────────────────────┐
  │  reads BI_MCP_CONFIG_HEADER, decodes, validates      │
  │  app/api/agent/route.ts · app/api/briefing/route.ts  │
  └───────────────────────┬──────────────────────────────┘
                          │  passes override to
                          ▼
  ┌─ DataSource factory ★ ──────────────────────────────┐ ← we are here
  │  makeDataSource(mode, override) — override wins,     │
  │  env is the fallback                                 │
  │  lib/data-source/index.ts                            │
  └──────────────────────────────────────────────────────┘
```

Zoom in: the "user-override" concept in this codebase is expressed at the *config layer*, not the *data-field layer*. Same discipline: if the user set it, don't overwrite it with the default.

## Structure pass

- **Layers:** UI (modal + localStorage) → HTTP header → route decode → DataSource factory → connectMcp. Five bands.
- **Axis: authority.** UI: user authority. Header/route: transports it. Factory: applies it. Env: fallback authority (deploy-time). User override wins over env when present.
- **Seam:** the `McpConfigOverride` shape in `lib/mcp/config.ts:30`. That's the contract between UI and server.

## How it works

### Move 1 — the mental model

Two authority levels: **user (per-request)** and **deploy (env)**. Per-request wins when set. When unset, deploy env is the default. Neither ever overwrites user-set state silently.

```
  Authority hierarchy — user always wins when present

  request comes in
    │
    ▼
  ┌──────────────────────┐
  │ header present?      │
  └──────────┬───────────┘
             │
      ┌──────┴──────┐
      │             │
      ▼ yes         ▼ no
   parse header   fall through
   → override →   to env vars
   validate       (MCP_URL,
   apply          MCP_AUTH_TYPE,
                   MCP_BEARER_TOKEN)
```

This is the classic productivity-app pattern's cousin. The productivity-app version says "user marked this field as their own, don't overwrite when re-classifying." The blooming version says "user picked their own MCP server, don't fall back to the Bloomreach preset."

### Move 2 — the step-by-step walkthrough

**The override shape.** `lib/mcp/config.ts:30-34` — the JSON stored in localStorage and encoded into a per-request header:

```ts
// lib/mcp/config.ts:30
export interface McpConfigOverride {
  url?: string;
  authType?: McpAuthType;
  bearerToken?: string;
}
```

All fields optional. Partial overrides merge into env defaults — a user who sets only `url` keeps env-controlled auth.

**Where the header is read.** `app/api/agent/route.ts` and `app/api/briefing/route.ts` — early in the handler, before constructing the DataSource:

```ts
// simplified from both routes
import { BI_MCP_CONFIG_HEADER, decodeConfigHeader } from '@/lib/mcp/config';

const override = decodeConfigHeader(req.headers.get(BI_MCP_CONFIG_HEADER));
const dataSource = await makeDataSource(mode, sessionId, override);
```

`decodeConfigHeader()` returns `undefined` on missing/malformed. The factory treats `undefined` as "use env defaults."

**Where the merge happens.** `lib/data-source/index.ts` calls into `lib/mcp/connect.ts`, which composes the effective config as `{ ...envDefaults, ...override }`. Per-field, not per-object — so a user setting only `bearerToken` keeps the env-configured URL.

**Why the header transport, not a cookie.** Cookies would ride every fetch automatically but wouldn't compose with SSR/streaming as cleanly. The header is explicit — the client hook has to read localStorage and add it — but it makes the override boundary visible in every request. Every NDJSON call the UI makes explicitly opts into the override.

Diagram of the header roundtrip:

```
  User override — one request

  ┌─ user opens settings modal ────────────┐
  │  types URL + bearer token               │
  │  saves → localStorage[BI_MCP_CONFIG_KEY]│
  └──────────────────┬─────────────────────┘
                     │
                     ▼
  ┌─ every UI fetch ───────────────────────┐
  │  reads localStorage,                    │
  │  base64-encodes JSON,                   │
  │  adds header: BI_MCP_CONFIG_HEADER      │
  └──────────────────┬─────────────────────┘
                     │  HTTPS
                     ▼
  ┌─ route handler ────────────────────────┐
  │  decodes + validates                    │
  │  passes to makeDataSource(override)     │
  └──────────────────┬─────────────────────┘
                     │
                     ▼
  ┌─ connectMcp(override + env fallback) ──┐
  │  agents now run against user's server   │
  └────────────────────────────────────────┘
```

### Move 3 — the principle

If the user can control it, treat their choice as authoritative. Never silently overwrite user-set state with the default. Whether the "state" is a database field (the classic productivity-app case) or a session-scoped config (this codebase's case), the discipline is the same: check for override first, apply default only in its absence.

## Primary diagram

```
  User-override discipline — full frame

  ┌─ user (per-request authority) ─────────────────────────┐
  │  settings modal → localStorage[BI_MCP_CONFIG_KEY]      │
  │  { url?, authType?, bearerToken? }                     │
  └──────────────────────┬─────────────────────────────────┘
                         │  base64-encoded header
                         │  BI_MCP_CONFIG_HEADER
                         ▼
  ┌─ route ────────────────────────────────────────────────┐
  │  decodeConfigHeader() → McpConfigOverride | undefined  │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌─ makeDataSource(mode, sessionId, override?) ───────────┐
  │  effective config = { ...envDefaults, ...override }     │
  │  → connectMcp → auth strategy picked by authType         │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌─ deploy env (fallback authority) ──────────────────────┐
  │  MCP_URL · MCP_AUTH_TYPE · MCP_BEARER_TOKEN            │
  │  Bloomreach OAuth default when everything unset        │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

The "check for override before overwriting" pattern shows up in many productivity apps as `field_source: "user" | "llm"` + `overridden_at: timestamp`. This codebase's version is coarser — the whole DataSource config is either overridden or not — because there's no user-editable LLM output getting re-classified. But the discipline transfers. If blooming grows a "save my rec as my favorite phrasing" feature and then re-runs the recommendation agent, the classic override lock would apply to the saved phrasing.

Security: the override header rides plaintext on every request (HTTPS-only in production). The bearer token can end up in headers on Vercel's logs if a route errors mid-processing. The `lib/mcp/transport.ts:57-64` `redactSecrets()` helper is what stops that leak.

Related: **../06-production-serving/03-prompt-injection.md** (user input as untrusted at the LLM boundary). **../04-agents-and-tool-use/05-agent-memory.md** (would need overrides if long-term memory landed).

## Project exercises

### B1.9 · Add field-level override to a captured investigation

- **Exercise ID:** B1.9
- **What to build:** When a user edits a saved recommendation's title / rationale in the UI, mark that field with `_userEdited: true`. On any re-run of the recommendation agent for the same insight, preserve edited fields and only regenerate the un-edited ones.
- **Why it earns its place:** Ports the config-level user-override discipline down to the field level — the classic pattern from productivity apps, adapted to this domain. Interview signal: "we already have user override at the transport layer; here's what it looks like at the field layer."
- **Files to touch:** `lib/mcp/types.ts` (add `_userEdited?: string[]` to `Recommendation`), `lib/state/investigations.ts` (preserve edited fields on merge), `components/investigation/RecommendationCard.tsx` (inline edit + save).
- **Done when:** editing a rec's title, then rerunning the agent, keeps the user's title; a test verifies the merge logic.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: Doesn't the LLM output overwrite state the user has edited?**

Not in blooming's shape — recommendations are one-shot: the agent produces them once, the user reads them, and the codebase doesn't re-run the same agent against the same insight and diff the output. If it did, we'd need per-field `_userEdited` locks. Right now the equivalent discipline lives at the substrate layer: the user's MCP config override wins over env defaults, and env defaults never overwrite an explicit user choice. Same pattern, different granularity.

**Q: What if the user misconfigures the override?**

The route validates the shape via `decodeConfigHeader()`; malformed JSON returns `undefined` and the request falls through to env defaults. If the user's `url` is unreachable, the DataSource connect() throws, the route returns a graceful `error` NDJSON event, and the UI shows a reconnect banner. No silent fallback to the wrong server — the failure surfaces immediately.

## See also

- [../06-production-serving/03-prompt-injection.md](../06-production-serving/03-prompt-injection.md) — the trust boundary the override header rides.
- [08-provider-abstraction.md](08-provider-abstraction.md) — the model provider port has the same "user picks per invocation" shape at a different layer.
- [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md) — where field-level override would matter if memory landed.
