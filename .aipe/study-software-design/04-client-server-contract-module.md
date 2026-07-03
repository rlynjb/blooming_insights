# client/server contract module

## Subtitle

**Shared contract module** — one file owns the shape a client encodes and a server decodes, so neither side has to know about the other's storage. *Language-agnostic* (any codebase with a client/server split can copy this).

Role-vocabulary this file uses:

```
  contract          the type + validator shared by both sides   (McpConfigOverride + isMcpConfigOverride)
  encoder           the client-side function                    (encodeConfigHeader)
  decoder           the server-side function                    (decodeConfigHeader)
  transport         the wire format                             (base64-encoded JSON in an HTTP header)
  precedence chain  the merge rule when the header is absent    (override → env → hardcoded default)
```

## Zoom out — where this concept lives

The pattern sits at the trust boundary between the browser and the server. The browser holds a settings modal that lets a visitor override the MCP server URL, the auth type, and (for bearer auth) the bearer token. The server has env-var defaults it uses when the browser sends nothing. The contract module is the shared shape that lets both sides agree on what the override looks like.

```
  the client/server contract — one file the two sides both import

  ┌─ Browser ─────────────────────────────────────────────────┐
  │                                                             │
  │  McpConfigModal.tsx (settings UI)                          │
  │      │                                                     │
  │      │ write                                               │
  │      ▼                                                     │
  │  localStorage['bi:mcp_config']  (JSON)                     │
  │      │                                                     │
  │      │ read on every fetch                                 │
  │      ▼                                                     │
  │  useBriefingStream / useInvestigation hooks                │
  │      │                                                     │
  │      │ encodeConfigHeader(...)                             │
  │      ▼                                                     │
  │  fetch(..., {headers: {'x-bi-mcp-config': BASE64_JSON}})    │
  │                                                             │
  └───────────────────────────┬────────────────────────────────┘
                              │
                              │  HTTPS
                              │
  ┌───────────────────────────▼────────────────────────────────┐
  │                                                             │
  │  Server (Next.js route handler)                             │
  │      │                                                     │
  │      │ req.headers.get('x-bi-mcp-config')                  │
  │      ▼                                                     │
  │  decodeConfigHeader(header)                                │
  │      │                                                     │
  │      │ (null when header is missing/malformed)             │
  │      ▼                                                     │
  │  connectMcp(sessionId, override) — uses override if set,   │
  │                                    else falls through to env│
  │                                                             │
  └────────────────────────────────────────────────────────────┘

                        ▲
                        │
                        │  BOTH sides import from
                        │
  ┌─────────────────────┴─────────────────────────────────────┐
  │  lib/mcp/config.ts  (146 LOC)                              │  ← we are here
  │                                                             │
  │  interface McpConfigOverride                                │
  │  isMcpConfigOverride(v): v is McpConfigOverride            │
  │  normalizeConfig(c): McpConfigOverride                     │
  │  encodeConfigHeader(c): string                              │
  │  decodeConfigHeader(h): McpConfigOverride | null            │
  │  readPersistedConfig() / writePersistedConfig() / etc.     │
  │                                                             │
  │  BI_MCP_CONFIG_KEY = 'bi:mcp_config'                        │
  │  BI_MCP_CONFIG_HEADER = 'x-bi-mcp-config'                   │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

Every constant that appears in both sides (the storage key, the header name, the type shape) lives once in `lib/mcp/config.ts`. That's the pattern.

## Zoom in — what this pattern is

**A contract module** is a single file that owns:

1. The **type** the wire carries (`McpConfigOverride`)
2. A **runtime validator** (`isMcpConfigOverride`) — because the wire is untyped at the boundary
3. The **encoder** (client → wire)
4. The **decoder** (wire → client-typed value on server)
5. Any **shared constants** (storage key, header name)

The client and server both import from this file. Neither side reaches into the other's storage; both sides use the same encode/decode pair, so the shape stays in sync by construction.

## Structure pass — skeleton first

### Axes

The right axis to trace is **"what does each side see?"**

- Client: **sees localStorage** (`bi:mcp_config`), **sees the config modal UI**, **doesn't see env vars**.
- Wire: **sees an HTTP header** (`x-bi-mcp-config`) carrying base64 JSON.
- Server: **sees the header** (if present), **sees env vars** (always), **doesn't see localStorage**.

Same "what's visible" question, three different scopes. The wire is the narrow point — the least-privileged shape, small enough to fit in an HTTP header.

The information-hiding axis: the client doesn't know what env var names the server reads; the server doesn't know what localStorage keys the client uses. Only the wire shape is shared. That's the AOSD hiding win.

### Seams

Two load-bearing seams:

1. **The localStorage ↔ header seam** (browser-side): `readPersistedConfig()` reads storage; `encodeConfigHeader()` converts to the header string. Above the seam, code deals with typed `McpConfigOverride`; below the seam (in `fetch()` options), code deals with a string.

2. **The header ↔ env seam** (server-side): `decodeConfigHeader()` reads the header; the precedence chain in `mcpUrl()` and `buildAuthProvider()` picks header value if present, else env, else hardcoded default. Above the seam, `connectMcp()` deals with typed `McpConfigOverride | undefined`; below the seam, it deals with individual resolved values.

At both seams, the axis "who knows this decision?" flips — the storage-side knows the persistence details; the transport-side knows only the shape.

### Layered decomposition

Hold "what happens if the header is missing?" constant across the three layers:

- **Browser**: doesn't apply — the browser writes the header when localStorage has a config, omits it when localStorage is empty.
- **Wire**: doesn't apply — a missing header is just a missing header.
- **Server**: `decodeConfigHeader(null) === null` → precedence chain skips the override, uses env values, falls through to hardcoded default (`https://loomi-mcp-alpha.bloomreach.com/mcp/`).

Same question, one clear answer — "fall through, don't crash." That's the precedence chain's guarantee: any partial or missing override is safe.

## How it works

### Move 1 — the mental model

Think of the contract module like a **shared schema file** between two microservices. Both sides import the schema; both sides use the same validator; neither side reaches into the other's database. The wire is the narrow point; the schema is what makes the wire safe. Here the two "services" are just the browser and the Next.js route handler — same team, same repo, still separated by an HTTP boundary.

```
  the shape of the pattern — one file, two directions, three tiers

     tier 1: HARDCODED DEFAULT   ← saves fresh deploys (no env, no header)
           │                       'https://loomi-mcp-alpha.bloomreach.com/mcp/'
           │
           │  env supersedes default
           ▼
     tier 2: ENV VARS            ← what the deploy owner sets
           │                       MCP_URL / MCP_AUTH_TYPE / MCP_AUTH_TOKEN
           │
           │  header supersedes env
           ▼
     tier 3: HEADER OVERRIDE     ← what the browser visitor sets
                                   base64 JSON of McpConfigOverride

  each tier is INDEPENDENT — a partial override at tier 3 doesn't clobber
  tier 2; a missing header falls all the way through to tier 1
```

The contract module is what makes this precedence chain possible. Without a shared type + validator, tier 3 would either have to encode every field (defeating "partial override") or the server would have to reverse-engineer the client's storage shape (defeating information hiding).

### Move 2 — the walkthrough

Five parts to walk: the type, the validator, the normalizer, the encode/decode pair, and the precedence chain on the consumer side.

#### The type — `McpConfigOverride`

The whole thing, from `lib/mcp/config.ts:26-31`:

```typescript
export interface McpConfigOverride {
  url?: string;
  authType?: McpAuthType;    // 'oauth-bloomreach' | 'bearer' | 'anonymous'
  bearerToken?: string;
}
```

Every field optional. That's the "partial override" rule — the client can send just `url`, or just `authType`, or all three. What's absent falls through to env / default.

**What breaks if you require any field:** the modal has to force the user to fill every field before saving, or send stale defaults for the ones they didn't touch. Both are worse UX and both couple the client's storage to the server's env more tightly.

#### The validator — `isMcpConfigOverride`

The runtime guard, `lib/mcp/config.ts:50-60`:

```typescript
export function isMcpConfigOverride(value: unknown): value is McpConfigOverride {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.url !== undefined && typeof v.url !== 'string') return false;
  if (v.authType !== undefined) {
    if (typeof v.authType !== 'string') return false;
    if (!VALID_AUTH_TYPES.has(v.authType as McpAuthType)) return false;
  }
  if (v.bearerToken !== undefined && typeof v.bearerToken !== 'string') return false;
  return true;
}
```

**Why the guard exists:** the wire is `unknown`. TypeScript's `interface` guarantees nothing at the boundary — a malformed header, a stale localStorage from a prior version, a browser extension injecting bad data. The validator is the gatekeeper.

**Why it uses `VALID_AUTH_TYPES` (a Set) not a switch:** the discriminant is checked in exactly one place. If a fourth auth type is added, one line changes here plus one case in `makeAuthProvider`. Together those are the two edit points; nothing else in the codebase knows the discriminant set.

**What breaks if you skip the validator:** a browser extension writes `{authType: 'DROP TABLE users'}` to localStorage, the encoder blindly serializes it, the header decodes it, the factory switch falls through to no case — cascades into an unhelpful runtime error instead of the guard's clean rejection.

#### The normalizer — `normalizeConfig`

`lib/mcp/config.ts:63-70`:

```typescript
export function normalizeConfig(config: McpConfigOverride): McpConfigOverride {
  return {
    url: config.url && config.url.trim() ? config.url.trim() : undefined,
    authType: config.authType,
    bearerToken:
      config.bearerToken && config.bearerToken.trim() ? config.bearerToken.trim() : undefined,
  };
}
```

**The subtle rule:** empty strings become `undefined`. This is *what makes the precedence chain work* — a blank UI field doesn't clobber a set env value. Without normalization, a user who cleared the URL input would send `{url: ""}`, and the server-side check `override?.url ?? process.env.MCP_URL` would prefer the empty string over the env value. Normalization prevents that specific footgun.

**What breaks if you remove normalization:** a user clears the URL input and hits Save. Now the server dispatches to `https://` (invalid URL) instead of the env default. The visible bug is "why does the app break when I clear the URL?"; the invisible cause is the missing normalization.

#### The encoder + decoder — round-tripping over the wire

`lib/mcp/config.ts:77-100`:

```typescript
export function encodeConfigHeader(config: McpConfigOverride): string {
  const json = JSON.stringify(normalizeConfig(config));
  if (typeof btoa === 'function') return btoa(json);
  return Buffer.from(json, 'utf8').toString('base64');
}

export function decodeConfigHeader(header: string | null | undefined): McpConfigOverride | null {
  if (!header) return null;
  try {
    const json =
      typeof atob === 'function'
        ? atob(header)
        : Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!isMcpConfigOverride(parsed)) return null;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}
```

**Why base64:** HTTP headers are ASCII-only by protocol. If the URL contains non-ASCII characters (unicode domains, unusual characters in a bearer token), the header would either crash the fetch or get silently mangled. Base64 keeps it safe.

**Why the runtime detection (`typeof btoa`):** the client uses `btoa/atob` (browser globals); the server uses `Buffer` (Node.js). The same file is imported by both, so it has to handle both runtimes. Runtime detection is the one-liner that keeps this file a single source of truth.

**Why the decoder returns `null` instead of throwing:** a bad header shouldn't crash the request. The server logs `null`, falls through to env, and the request succeeds using defaults. This is deep-module error definition — the decoder *always returns a valid value* (a valid override or `null`), so downstream code has no error-handling branch.

#### The precedence chain on the consumer side

The consumer is `connectMcp` in `lib/mcp/connect.ts`. Two functions read the override:

```typescript
// lib/mcp/connect.ts:38-48 — the URL precedence chain
function mcpUrl(override?: McpConfigOverride): URL {
  const raw =
    override?.url ??                                            // tier 3: header
    process.env.MCP_URL ??                                       // tier 2: env (primary)
    process.env.BLOOMREACH_MCP_URL ??                            // tier 2: env (legacy)
    'https://loomi-mcp-alpha.bloomreach.com/mcp/';               // tier 1: hardcoded default
  return new URL(raw.replace(/\/+$/, ''));
}
```

```typescript
// lib/mcp/connect.ts:148-167 — the auth precedence chain
async function buildAuthProvider(
  sessionId: string,
  override?: McpConfigOverride,
): Promise<OAuthClientProvider> {
  const env = readAuthEnv();
  const type: McpAuthType = override?.authType ?? env.type;
  //                        ▲ header wins; else env; else the parseAuthType default
  const bearerToken =
    type === 'bearer' ? (override?.bearerToken ?? env.bearerToken) : undefined;
  //                    ▲ same tier order for the token
  if (type === 'bearer' && !bearerToken) {
    throw new Error(
      'bearer auth type selected but no token provided — set one in Settings or via MCP_AUTH_TOKEN env.',
    );
  }
  return makeAuthProvider({
    type,
    sessionId,
    redirectUri: type === 'oauth-bloomreach' ? await redirectUri() : undefined,
    bearerToken,
  });
}
```

**The three tiers, all in one file:** you can read `mcpUrl()` top-to-bottom and see the whole chain. Every `??` is one tier fallback. The hardcoded default is the last coalesce; there's no path that returns undefined.

### Move 2.5 — Phase A vs Phase B

**Phase A** (before Session D): env was the only source of the MCP config. To change the server URL or auth type, you had to redeploy with different env vars. Portfolio visitors couldn't try their own MCP server without forking.

**Phase B** (Session D, current): the settings modal writes localStorage → the hooks send a header on every fetch → the server decodes and merges. Env still wins when there's no header (backward compat); hardcoded default still wins when there's no env (unconfigured deploys still work).

```
  Phase A                                Phase B
  ───────                                ───────

  ┌──────────────┐                       ┌──────────────┐
  │  browser     │                       │  browser     │
  │  (no config) │                       │  writes      │
  └───────┬──────┘                       │  localStorage │
          │                              └───────┬──────┘
          │                                       │
          │  fetch (no override header)           │  fetch (header carries
          ▼                                       │  base64 config)
  ┌───────────────┐                               ▼
  │ server reads  │                       ┌────────────────┐
  │ env vars only │                       │ server reads   │
  │               │                       │ header + env   │
  │ ↓             │                       │                │
  │ MCP_URL       │                       │ ↓              │
  │ MCP_AUTH_TYPE │                       │ header > env > │
  │ MCP_AUTH_TOKEN│                       │ default        │
  └───────────────┘                       └────────────────┘
```

**Migration cost:** one new file (`lib/mcp/config.ts`, 146 LOC), one new component (`components/settings/McpConfigModal.tsx`, ~300 LOC), plus header-attachment lines in the two streaming hooks (`useBriefingStream.ts`, `useInvestigation.ts`). Every existing env-driven deployment kept working because tier 2 didn't change — the header override just *adds* tier 3.

### Move 3 — the principle

**The principle:** when a client and server need to agree on a shape at a trust boundary, put the shape in ONE file that both sides import. Neither side should reach into the other's storage. The wire carries only what the shape says, and the shape is enforced by a runtime validator on the server (because the wire is untyped at the boundary).

The deeper move is **information hiding across the trust boundary**. The client's localStorage is private to the client; the server's env is private to the server. Both sides expose only what the wire needs. When you add tier 3 (the header), you don't erase tiers 2 or 1 — you layer on top, so partial overrides work and unconfigured deploys still function.

This is the same discipline as REST API versioning, gRPC .proto files, or any schema-first client/server design. What's unusual here is doing it *within a monorepo* — most codebases would inline the shape in both places and let it drift. The 146-LOC contract module is the small cost that prevents the drift.

## Primary diagram

```
  the contract module in one picture — one shape, three tiers, both directions

                       ┌─── lib/mcp/config.ts (146 LOC) ───┐
                       │                                     │
                       │  the SHARED SHAPE:                  │
                       │    interface McpConfigOverride      │
                       │    { url?, authType?, bearerToken? }│
                       │                                     │
                       │  the runtime VALIDATOR:             │
                       │    isMcpConfigOverride(v): guard    │
                       │                                     │
                       │  the NORMALIZER:                    │
                       │    normalizeConfig(c): c            │
                       │    (empty strings → undefined)      │
                       │                                     │
                       │  the ENCODE/DECODE PAIR:            │
                       │    encodeConfigHeader(c): string    │
                       │    decodeConfigHeader(h): c | null  │
                       │                                     │
                       │  the CONSTANTS:                     │
                       │    BI_MCP_CONFIG_KEY = 'bi:mcp_config'│
                       │    BI_MCP_CONFIG_HEADER = 'x-bi-mcp-config'│
                       │                                     │
                       └────────┬──────────────────┬─────────┘
                                │                  │
                       imports  │                  │  imports
                                │                  │
              ┌─────────────────▼──────────┐  ┌────▼──────────────────┐
              │  Browser side              │  │  Server side           │
              │                              │  │                        │
              │  McpConfigModal.tsx         │  │  connectMcp (in        │
              │    writes localStorage       │  │    lib/mcp/connect.ts) │
              │                              │  │                        │
              │  useBriefingStream          │  │  route handlers        │
              │  useInvestigation           │  │    read header from    │
              │    read localStorage,        │  │    req.headers         │
              │    encodeConfigHeader,       │  │                        │
              │    attach to fetch           │  │  mcpUrl(override) —   │
              │                              │  │    tier 3 → tier 2 →  │
              └──────────────────────────────┘  │    tier 1              │
                                                │                        │
                                                │  buildAuthProvider —  │
                                                │    same precedence    │
                                                │                        │
                                                └────────────────────────┘

  the WIRE between them: HTTP header `x-bi-mcp-config: <base64-encoded JSON>`

  precedence chain (both mcpUrl and buildAuthProvider follow this):
      override.field ?? process.env.EQUIVALENT ?? hardcoded default
```

## Elaborate

**Where the pattern comes from.** Schema-first client/server design is decades old — it's the pattern behind SOAP WSDLs, gRPC .proto files, GraphQL SDLs, and OpenAPI specs. What's specific to *this* codebase is that the client and server are in the same monorepo, so the contract module is a plain TypeScript file (not a generated schema). The pattern still applies: one source of truth, both sides import it.

**What problem the shape solves for this repo.** Before Session D, the only way to point the app at a different MCP server was to change env vars and redeploy. That's fine for the deploy owner but wrong for portfolio visitors — they can't try their own bearer token or their own MCP server. The contract module lets the UI expose an override without leaking the server's env structure to the browser. The visitor's localStorage stays private to them; the server's env stays private to the deploy.

**Why the header, not a cookie:** the header attaches to specific streaming requests (briefing, agent). A cookie would ride every request including static asset fetches. Also: cookies compose with server-side session state (the `bi_auth` encrypted cookie for OAuth tokens); adding MCP config to the same cookie layer would tangle concerns. The header is scoped to exactly the requests that consume the MCP config.

**Security caveats named in-file:** the bearer token rides the header plaintext on every streaming request. The file's own header comment names this as future work ("encrypt bearer token into a short-lived cookie server-side so it doesn't ride the header plaintext on every subsequent request"). HTTPS in production is the current defense. This is honest about the tradeoff, not silent about it.

**Adjacent concepts.**

- **Ports & adapters** — the contract module is the "port" for the client/server configuration boundary. The client is one adapter (writes localStorage, encodes header); the server is another adapter (reads header, merges with env). Same shape as file 01 at a different scope.
- **Feature flags** — the precedence chain (tier 3 → tier 2 → tier 1) is structurally similar to feature-flag precedence (per-request override → per-user setting → default). Different intent (config vs behavior toggle) but the same fall-through discipline.
- **Environment inheritance in build systems** — Make's `?=` operator, Docker's `ENV` with build args, Kubernetes ConfigMap + env override. All follow the same "narrower scope wins" rule. The pattern is transferable to any layered configuration problem.

**Where to read more.** Chapter on Information Hiding in *A Philosophy of Software Design*. Any modern API design book discusses schema-first client/server contracts. For the tier-precedence discipline specifically, look at 12-factor app configuration or any config-management library's cascade rules.

## Interview defense

### Q: Why not have the client send the raw env-var-shaped object in the header?

**Answer:** Two reasons — information hiding and future-proofing.

Information hiding: the client shouldn't know that the server uses `MCP_AUTH_TYPE` (vs `MCP_AUTH_MODE`, vs `AUTH_STRATEGY`). If the server renames its env variable, no client code changes. The `McpConfigOverride` shape is the *concept* — the server's env names are one implementation of that concept.

Future-proofing: today the server reads env vars. Tomorrow it might read from a database, a secrets manager, or a runtime config service. The header carries the concept, not the source. Rewriting the server-side resolution changes zero client code.

Anchor: *lib/mcp/config.ts:26-31 (the shape) + lib/mcp/connect.ts:38-48 (the precedence chain). The shape and the resolution are separate.*

### Q: What if a user's localStorage has stale config from a prior version?

**Answer:** The runtime validator (`isMcpConfigOverride`) rejects it. Two paths:

1. Client-side: `readPersistedConfig()` at `lib/mcp/config.ts:106-117` reads localStorage, tries to parse and validate. If validation fails, returns `null` — the modal loads with default values, no header is sent, the server uses env.
2. Server-side: even if the client somehow sends a bad header (bypassing the client-side guard), `decodeConfigHeader()` at `lib/mcp/config.ts:87-100` validates again. Fails → returns `null` → precedence chain uses env.

Two-layer validation is deliberate — the wire is untyped, the storage is untyped, both boundaries need guards. Trust the shape only after `isMcpConfigOverride` says it's the shape.

Anchor: *lib/mcp/config.ts:50-60 (the guard), :87-100 (decoder using guard), :106-117 (storage reader using guard).*

### Q: The bearer token rides the header on every streaming request. Isn't that a leak?

**Answer:** It's a documented trade-off, not a leak. Three things constrain it:

1. HTTPS in production — the header is TLS-encrypted end-to-end.
2. The server is the only consumer that decodes it; the token doesn't hit a database, doesn't get logged (`redactSecrets` in `lib/mcp/transport.ts:66-76` strips bearer patterns before any error body is stored).
3. The file's own header comment names the future work — encrypt the bearer into a short-lived cookie server-side after the first request. That's the mitigation when the pattern grows past the current use.

The current use is portfolio visitors trying their own MCP server. For that use, the header trade-off is honest. If this were a production auth mechanism, the mitigation would be required, not future work.

Anchor: *lib/mcp/config.ts:18-22 (the header comment names the trade-off), lib/mcp/transport.ts:55-76 (the redaction that prevents log leakage).*

### Q: If the header is missing, how does the server know what URL to hit?

**Answer:** The precedence chain in `mcpUrl()` at `lib/mcp/connect.ts:38-48`. Three tiers, coalesced with `??`:

1. Header override (tier 3, from the browser)
2. `MCP_URL` env, then `BLOOMREACH_MCP_URL` env (tier 2, legacy alias)
3. Hardcoded `https://loomi-mcp-alpha.bloomreach.com/mcp/` default (tier 1)

Every missing tier falls through to the next. A fresh deploy with no env and no header still works — it hits the alpha Bloomreach endpoint. Setting `MCP_URL` in the deploy replaces tier 1 for that deploy. A visitor overriding via the modal replaces tier 2 for that session.

This is the whole design: partial overrides at higher tiers don't clobber lower tiers, and unconfigured deploys still function.

Anchor: *lib/mcp/connect.ts:38-48 — the whole chain fits on one screen; every `??` is one tier.*

## See also

- [audit.md](./audit.md) — lens 3 (information hiding) names this module as a textbook win; lens 6 (errors) names the null-return decoder as an error-definition win.
- [01-port-adapter-decorator-preset-factory.md](./01-port-adapter-decorator-preset-factory.md) — the DataSource port that this config eventually shapes (URL and auth flow both flow into the port's configuration).
- [02-auth-strategy-injection.md](./02-auth-strategy-injection.md) — how the `authType` field from this contract selects one of the three auth providers.
- `.aipe/read-aposd/` (chapter on Information Hiding) — the primitive taught abstractly.
- `.aipe/study-security/` (if present) — the trust-boundary discussion that this contract sits on top of.
