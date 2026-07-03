# 06 — Per-request UI config override transport

**Industry name:** per-request configuration header, client-persisted, server-validated. *Type: Industry standard.*

## Zoom out, then zoom in

Session B made auth swappable at the deploy level (env vars).
Session D took the last step: let a browser visitor override
the deploy's default MCP config from a settings modal —
without server-side per-user state, without a fork, without
touching env. The transport is a base64-encoded JSON header
that rides on every streaming fetch. This file walks the whole
transport end to end.

```
  Zoom out — where the config override transport sits

  ┌─ UI layer ─────────────────────────────────────────────┐
  │  McpConfigModal (URL / authType / bearerToken)         │
  │  writes localStorage['bi:mcp_config']                  │
  └───────────────────────┬────────────────────────────────┘
                          │  persistedConfigHeader() → base64
  ┌─ transport ────────────▼───────────────────────────────┐
  │  x-bi-mcp-config: <base64 JSON>                        │
  │  attached to every /api/briefing, /api/agent fetch     │
  └───────────────────────┬────────────────────────────────┘
  ┌─ Service layer ────────▼───────────────────────────────┐
  │  decodeConfigHeader → normalize → McpConfigOverride    │
  │  makeDataSource(mode, sid, override)                   │
  │  buildAuthProvider(sid, override) merges override→env  │
  └────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is one this repo needed a specific
piece of: a user-controlled configuration knob that (a) doesn't
require a login, (b) doesn't touch server-side per-user state,
and (c) can't crash the request if it's malformed. The
mechanism is a validated header on every fetch, with a
localStorage source and an env fallback.

## Structure pass

Three layers (browser / wire / server), one axis: **what does
each layer do to the config value?**

```
  Axis "what happens to the config here?" — down the layers

  ┌─ Browser ─────────────────────────────────────────────┐
  │ writes:   normalizeConfig(input) → localStorage       │
  │ reads:    readPersistedConfig() on every fetch        │
  │ encodes:  encodeConfigHeader() → base64 JSON          │
  └────────────────────┬──────────────────────────────────┘
                       │  seam: HTTP header
  ┌─ Wire ─────────────▼──────────────────────────────────┐
  │ carries:  x-bi-mcp-config: <base64>                   │
  │ shape:    ASCII-safe string, single value             │
  └────────────────────┬──────────────────────────────────┘
                       │  seam: decodeConfigHeader
  ┌─ Server ───────────▼──────────────────────────────────┐
  │ decodes:  atob → JSON.parse → isMcpConfigOverride     │
  │ merges:   override → env → default (precedence chain) │
  │ threads:  makeDataSource(mode, sid, override) →       │
  │           connectMcp(sid, override) → transport URL + │
  │           auth provider selection                     │
  └───────────────────────────────────────────────────────┘
```

The two seams — encode (browser) and decode (server) — are
both defensive. The encoder normalizes (empty strings become
undefined). The decoder validates (`isMcpConfigOverride`) and
returns `null` on any failure. A bad header can't reach
`makeDataSource`.

## How it works

### Move 1 — the mental model

You've used feature flags with an override URL param — same
idea, wider surface. The user's choice is *client-owned* (in
their localStorage), *transport is a header* (not a query
param, so it's not in the URL), and the *server's discipline
is validation, not trust*. Missing or malformed → fall through
to defaults; well-formed → override the defaults for this
request.

```
  Pattern — client-persisted, header-transported, server-validated

  ┌─ Browser ─────────┐
  │  McpConfigModal   │
  │  writes to        │
  │  localStorage     │
  └────────┬──────────┘
           │  read on every fetch
           ▼
  ┌─ persistedConfigHeader() ─┐
  │  readPersistedConfig →    │
  │  normalizeConfig →        │
  │  encodeConfigHeader (b64) │
  └────────┬──────────────────┘
           │  attach as header
           ▼
  ┌─ fetch(url, { headers }) ─┐
  │  x-bi-mcp-config: <b64>   │
  └────────┬──────────────────┘
           │  transport
           ▼
  ┌─ decodeConfigHeader ──────┐
  │  atob → JSON.parse →      │
  │  isMcpConfigOverride →    │
  │  normalizeConfig          │
  └────────┬──────────────────┘
           │
      ┌────┴────┐
      ▼         ▼
    null?      valid?
    →fall-      →use in
     through     factory
```

### Move 2 — step by step

**Part 1: the shape.** All fields optional; partial overrides
merge into env defaults.

```ts
// lib/mcp/config.ts:26-45
export interface McpConfigOverride {
  url?: string;
  authType?: McpAuthType;      // 'oauth-bloomreach' | 'bearer' | 'anonymous'
  bearerToken?: string;
}

export const BI_MCP_CONFIG_KEY = 'bi:mcp_config';
export const BI_MCP_CONFIG_HEADER = 'x-bi-mcp-config';

const VALID_AUTH_TYPES = new Set<McpAuthType>([
  'oauth-bloomreach', 'bearer', 'anonymous',
]);
```

The additive design matters: setting only `url` in the UI
keeps `MCP_AUTH_TYPE` env-controlled. The validator
(`isMcpConfigOverride`) enforces "the fields I have are
well-typed" without enforcing "all fields are present."

**Part 2: the validator.** Type guard, five checks, no throws.

```ts
// lib/mcp/config.ts:50-60
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

Five predicates — one for object-ness, three for typed fields,
one for the auth-type whitelist. Anything else the caller sent
is ignored (extra fields don't fail validation; they just
don't ride through). That's why a malformed / evolving config
in the wild degrades gracefully.

**Part 3: the normalizer.** Empty strings become undefined,
which is the "unset" sentinel across the merge.

```ts
// lib/mcp/config.ts:63-70
export function normalizeConfig(config: McpConfigOverride): McpConfigOverride {
  return {
    url: config.url && config.url.trim() ? config.url.trim() : undefined,
    authType: config.authType,
    bearerToken:
      config.bearerToken && config.bearerToken.trim() ? config.bearerToken.trim() : undefined,
  };
}
```

Rationale: if the user clears the URL field in the modal, we
don't want to clobber a set `MCP_URL` env with an empty
string. Normalization gets the empty → undefined mapping right
once, and both the localStorage writer and the header round-
trip reach for it.

**Part 4: the header round-trip.** Base64-JSON in both
directions. Base64 because HTTP headers are ASCII-only by
protocol; JSON because it's the shape the server code already
works with.

```ts
// lib/mcp/config.ts:77-100
export function encodeConfigHeader(config: McpConfigOverride): string {
  const json = JSON.stringify(normalizeConfig(config));
  if (typeof btoa === 'function') return btoa(json);          // browser
  return Buffer.from(json, 'utf8').toString('base64');        // Node
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

The runtime detection (`typeof btoa === 'function'`) makes the
module SSR-safe — during Next.js server rendering, `btoa` is
undefined, so the Node path takes over. Same trick on the
decoder side.

The `try/catch` returning `null` on any parse failure is
deliberate: "a bad header shouldn't crash the request"
(`lib/mcp/config.ts:86-87`). This is one of the ranked red
flags in the audit — silent fallback means a debugging
visitor can't tell why their config isn't taking effect. The
tradeoff was chosen anyway; noisy invalidation would risk
breaking the request for a header the deploy doesn't require.

**Part 5: the localStorage helpers.** SSR-safe, JSON-safe,
empty-safe.

```ts
// lib/mcp/config.ts:106-138  (skeleton)
export function readPersistedConfig(): McpConfigOverride | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(BI_MCP_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isMcpConfigOverride(parsed)) return null;
    return normalizeConfig(parsed);
  } catch { return null; }
}

export function writePersistedConfig(config: McpConfigOverride | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (config === null) { localStorage.removeItem(BI_MCP_CONFIG_KEY); return; }
    const normalized = normalizeConfig(config);
    // If everything's empty, treat as unset.
    if (!normalized.url && !normalized.authType && !normalized.bearerToken) {
      localStorage.removeItem(BI_MCP_CONFIG_KEY);
      return;
    }
    localStorage.setItem(BI_MCP_CONFIG_KEY, JSON.stringify(normalized));
  } catch { /* localStorage unavailable — silent no-op */ }
}

export function persistedConfigHeader(): string | null {
  const config = readPersistedConfig();
  if (!config) return null;
  return encodeConfigHeader(config);
}
```

Three failure classes handled uniformly: no localStorage
(SSR), bad JSON, empty config. Each returns `null` and the
caller (`useBriefingStream`, `useInvestigation`) simply omits
the header.

**Part 6: the server-side merge.** Precedence chain lives in
`buildAuthProvider`.

```
  Layers-and-hops — the merge chain

  ┌─ Request ─────────┐  hop 1: header decoded
  │  override?        │
  └────────┬──────────┘
           │
  ┌─ readAuthEnv ─────▼──────┐  hop 2: env read
  │  MCP_AUTH_TYPE           │
  │  MCP_AUTH_TOKEN          │
  └────────┬──────────────────┘
           │
  ┌─ merge (buildAuthProvider) ─┐  hop 3: override wins
  │  type = override?.authType   │
  │       ?? env.type            │
  │       ?? 'oauth-bloomreach'  │
  │  token = override?.bearerToken│
  │         ?? env.bearerToken   │
  └────────┬─────────────────────┘
           │
  ┌─ mcpUrl(override) ▼──────────┐  hop 4: URL precedence
  │  override.url ??             │
  │  MCP_URL ??                  │
  │  BLOOMREACH_MCP_URL ??       │
  │  hardcoded alpha default     │
  └──────────────────────────────┘
```

Three consequences worth calling out. First, the URL and the
auth type are independently overridable — a visitor can point
at a different MCP server while keeping the default auth
type. Second, the merge is per-field, not all-or-nothing; the
override is *additive*. Third, when the deploy hasn't been
configured at all (no env vars), an unconfigured URL still
falls through to the Bloomreach alpha default, so an out-of-
box run still shows the product working.

**Part 7: the UI settings modal.** ~300 LOC in
`components/settings/McpConfigModal.tsx`. URL text input, auth-
type dropdown, conditional bearer-token field (only visible
when authType='bearer'), Save + Reset buttons.

```ts
// components/settings/McpConfigModal.tsx:52-69  (save + reset)
const save = () => {
  const config: McpConfigOverride = {
    url: url.trim() || undefined,
    authType,
    bearerToken: authType === 'bearer' ? bearerToken.trim() || undefined : undefined,
  };
  if (authType === 'bearer' && !config.bearerToken) return;   // ← guard
  writePersistedConfig(config);
  onSaved?.();
  onClose();
};

const reset = () => {
  writePersistedConfig(null);
  onSaved?.();
  onClose();
};
```

Two UX details: (1) bearer selected without a token is a
no-op (the guard); the UI shows the warning next to the field
instead of saving a broken config. (2) After save, the modal
fires `onSaved` which the parent uses to reload the page so
in-flight fetches restart with the new config.

The modal is only visible when the mode toggle is on
`live-mcp` — no reason to configure MCP if you're using the
synthetic adapter. Trust-boundary warnings are surfaced right
in the UI copy: bearer tokens sit in localStorage, unencrypted;
OAuth uses the existing `bi_auth` cookie discipline (AES-256-
GCM).

### Move 3 — the principle

Per-request configuration transports let a single deploy
behave differently for different visitors without introducing
server-side per-user state. The tradeoff you're accepting:
whatever the client sends, the server has to validate before
using — no trust in the header. That's the pattern; every
piece here (the type guard, the base64 wrapper, the merge
precedence, the null-safe helpers) is there because the trust
model is "client can send anything; server accepts only
well-formed things."

## Primary diagram

```
  Config transport — full recap

  ┌─ UI (McpConfigModal) ─────────────────────────────────┐
  │  user picks: URL / authType / bearerToken             │
  │  save() → normalizeConfig → JSON.stringify →          │
  │           localStorage.setItem('bi:mcp_config', ...)   │
  └───────────────────┬───────────────────────────────────┘
                      │  page reload
                      ▼
  ┌─ Streaming hooks ─────────────────────────────────────┐
  │  useBriefingStream / useInvestigation                 │
  │  before fetch():                                      │
  │    const mcpHeader = persistedConfigHeader();         │
  │    fetch(url, { headers:                              │
  │      mcpHeader ? { [BI_MCP_CONFIG_HEADER]: mcpHeader }│
  │      : undefined                                      │
  │    })                                                 │
  └───────────────────┬───────────────────────────────────┘
                      │  x-bi-mcp-config: <base64 JSON>
                      ▼
  ┌─ Route handler ───────────────────────────────────────┐
  │  const override = decodeConfigHeader(                 │
  │    req.headers.get(BI_MCP_CONFIG_HEADER)              │
  │  );                                                   │
  │  //  null | McpConfigOverride                         │
  │  makeDataSource(mode, sid, override)                  │
  └───────────────────┬───────────────────────────────────┘
                      │
                      ▼
  ┌─ connectMcp / buildAuthProvider ──────────────────────┐
  │  URL:   override.url ?? MCP_URL ?? Bloomreach alpha   │
  │  auth:  override.authType ?? MCP_AUTH_TYPE ??         │
  │         'oauth-bloomreach'                            │
  │  token: override.bearerToken ?? MCP_AUTH_TOKEN        │
  └───────────────────────────────────────────────────────┘
```

## Elaborate

The pattern is close relatives of feature-flag override
headers (LaunchDarkly, Statsig) — the difference is that
feature flags typically default OFF and the server treats them
as safe once received. Here the header defaults absent and the
server validates aggressively because the value affects the
egress URL, which is a security-adjacent decision.

The base64 wrapper is because HTTP headers are formally
ASCII-only. A URL with a Unicode character (rare but not
impossible for internal deploys) would fail to ride a raw
JSON header. Base64 makes it always safe.

Where you'd reach for something else: (1) values large enough
that URL-safe encoding matters (use JWT or a signed cookie);
(2) values that must survive a page navigation (use
sessionStorage + URL params instead of localStorage); (3)
values that the server must trust (use a signed cookie set by
your own auth boundary, not a header the client controls).

## Interview defense

**Q: Why not just make the config a URL query param?**

A: Two reasons. First, query params show up in server logs and
browser history — not somewhere a bearer token should live.
Second, query params aren't cleanly independent per fetch —
you'd need to re-append the param on every fetch call.
Headers ride once per fetch call as expected transport.

**Q: What happens with a malformed header?**

A: `decodeConfigHeader` returns `null`, `makeDataSource`
receives `undefined`, the factory falls through to env
config. Debug-visibility cost: the user has no signal that
their header was rejected. Chosen trade — a bad header can't
break the request. Fix path if we needed observability: log
malformed headers at the route level with a hash of the
input.

**Q: Isn't localStorage a bad place for a bearer token?**

A: Yes. The modal calls this out in its trust-boundary copy.
It rides plaintext in the header on every fetch, and any XSS
on this origin can read it. The mitigation path is a short-
lived encrypted cookie server-side (called out at
`lib/mcp/config.ts:22-23`). For a portfolio demo talking to
non-production MCP servers, the risk is acceptable; for
production credentials, the modal tells you not to.

**Q: What's the one part everyone forgets in this transport?**

A: Empty-string normalization. If a user clears the URL field
in the modal and hits save, the naive path writes
`{ url: '' }` to localStorage, the header carries `{ url: '' }`,
and the server takes `override.url ?? env.MCP_URL` — but `''`
isn't nullish, so it clobbers the env URL and the fetch goes
to an empty string. `normalizeConfig` handles this once at the
edge; both the writer and the encoder route through it.

## See also

- `01-request-flow.md` — the fetch path that carries the header
- `02-auth-boundary-and-swappable-mcp.md` — how the decoded
  override selects the auth strategy
- `03-provider-abstraction-and-datasource-seam.md` — the
  factory that receives the decoded override
