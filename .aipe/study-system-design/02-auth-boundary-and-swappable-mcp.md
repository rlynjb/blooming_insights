# 02 — Auth boundary and swappable MCP

**Industry name:** strategy pattern behind a factory, plus a trust boundary at the MCP URL. *Type: Industry standard.*

## Zoom out, then zoom in

The MCP server owns the workspace data. Getting to it requires
some flavor of auth — OAuth 2.1 for the Bloomreach preset, a
bearer token for private MCP servers, or nothing for local dev
servers. Before Session B, Bloomreach OAuth was baked into the
connect path; now it's one strategy behind a factory.

```
  Zoom out — where the auth boundary sits

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  McpConfigModal → localStorage['bi:mcp_config']         │
  │  (URL, authType, bearerToken)                           │
  └───────────────────────┬─────────────────────────────────┘
                          │  x-bi-mcp-config (base64 JSON)
  ┌─ Service layer ───────▼─────────────────────────────────┐
  │  connectMcp → buildAuthProvider →                       │
  │  ★ makeAuthProvider({type, sessionId, redirectUri, ★    │
  │  ★                   bearerToken})                 ★    │
  │  StreamableHTTPClientTransport(url, { authProvider })   │
  └───────────────────────┬─────────────────────────────────┘
                          │  MCP over HTTPS + Authorization header
  ┌─ Provider layer (trust boundary crossed) ───────────────┐
  │  configured MCP server: sees every tool call + token    │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is a strategy (`OAuthClientProvider`
implementations) selected by a factory (`makeAuthProvider`),
with the *choice* of strategy coming from a precedence chain:
per-request override → env → default. Three strategies exist
because MCP servers in the wild expect three different auth
shapes, and the deploy shouldn't have to pick one at build time.

## Structure pass

Three layers (UI / factory / provider), one axis: **what
identity does the request carry?**

```
  Axis "what identity is on the wire?" — trace it down the layers

  ┌─ UI (browser) ─────────────────────────────────────────────┐
  │  identity = user's own choice: OAuth session,              │
  │             a bearer token they pasted, or "none"          │
  └──────────────────────┬─────────────────────────────────────┘
                         │  seam: config header → route
  ┌─ Factory ────────────▼─────────────────────────────────────┐
  │  identity resolved: buildAuthProvider(sessionId, override) │
  │  picks a concrete OAuthClientProvider                      │
  └──────────────────────┬─────────────────────────────────────┘
                         │  seam: OAuthClientProvider.tokens()
  ┌─ Provider ───────────▼─────────────────────────────────────┐
  │  identity ON the wire:                                     │
  │    Bloomreach → 'Bearer <oauth-access-token>'              │
  │    Bearer     → 'Bearer <static-token>'                    │
  │    Anonymous  → no Authorization header                    │
  └────────────────────────────────────────────────────────────┘
```

Two seams. The first (config header → route) is where the
user's preference becomes a resolved type. The second
(`OAuthClientProvider.tokens()`) is where the resolved type
becomes bytes on the wire. The trust boundary lives at the
MCP URL: everything above it is the deploy's code; everything
below it is a server the user chose to trust.

## How it works

### Move 1 — the mental model

You've written `useContext(AuthContext)` — same idea, different
altitude. There's one interface (`OAuthClientProvider`), and any
implementation of it plugs into the same slot the MCP SDK's
transport reads from. The transport doesn't care whether the
token came from an OAuth dance, an env var, or nowhere; it
calls `provider.tokens()` and puts whatever comes back in the
`Authorization` header.

```
  Pattern — one interface, three implementations

  ┌─ OAuthClientProvider interface ──────────────┐
  │   tokens(): OAuthTokens | undefined          │
  │   redirectToAuthorization()                  │
  │   saveTokens() / saveCodeVerifier() / ...    │
  └───────────────────┬──────────────────────────┘
                      │ implements
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
  ┌────────────┐ ┌────────────┐ ┌────────────┐
  │ Bloomreach │ │  Bearer    │ │ Anonymous  │
  │ (OAuth 2.1 │ │ (static    │ │ (no auth   │
  │  +PKCE+DCR)│ │  token)    │ │  header)   │
  └────────────┘ └────────────┘ └────────────┘
```

### Move 2 — step by step

**Part 1: the precedence chain resolves the type.** Server-
side, `buildAuthProvider` reads env, then lets the override win.

```ts
// lib/mcp/connect.ts:148-167
async function buildAuthProvider(
  sessionId: string,
  override?: McpConfigOverride,
): Promise<OAuthClientProvider> {
  const env = readAuthEnv();
  const type: McpAuthType = override?.authType ?? env.type;
  const bearerToken =
    type === 'bearer' ? (override?.bearerToken ?? env.bearerToken) : undefined;
  if (type === 'bearer' && !bearerToken) {
    throw new Error('bearer auth type selected but no token provided ...');
  }
  return makeAuthProvider({
    type,
    sessionId,
    redirectUri: type === 'oauth-bloomreach' ? await redirectUri() : undefined,
    bearerToken,
  });
}
```

The chain: `override?.authType ?? env.type ?? 'oauth-bloomreach'`.
That last fallback lives inside `parseAuthType`
(`lib/mcp/auth-providers/index.ts:36-40`) — an unknown or
missing env yields `'oauth-bloomreach'`, preserving backward
compat with the pre-swappable state.

```
  Layers-and-hops — how the type gets resolved

  ┌─ UI ─────────────────┐  hop 1: config header attached
  │  bi:mcp_config       │  { authType: 'bearer',
  │  { authType, token } │    bearerToken: '...' }
  └──────────┬───────────┘
             │
             ▼
  ┌─ Route ──────────────┐  hop 2: decodeConfigHeader
  │  decodeConfigHeader  │  → McpConfigOverride | null
  └──────────┬───────────┘
             │
             ▼
  ┌─ connectMcp ─────────┐  hop 3: buildAuthProvider
  │  readAuthEnv()       │  merges: override → env → default
  │  merge with override │
  └──────────┬───────────┘
             │
             ▼
  ┌─ makeAuthProvider ───┐  hop 4: switch on type
  │  switch(type):       │  returns concrete provider instance
  │    'oauth-bloomreach'│
  │    'bearer'          │
  │    'anonymous'       │
  └──────────────────────┘
```

**Part 2: the factory picks the concrete class.**

```ts
// lib/mcp/auth-providers/index.ts:56-76
export function makeAuthProvider(config: McpAuthConfig): OAuthClientProvider {
  switch (config.type) {
    case 'oauth-bloomreach': {
      if (!config.sessionId || !config.redirectUri) {
        throw new Error('oauth-bloomreach AuthProvider requires sessionId + redirectUri.');
      }
      return new BloomreachAuthProvider(config.sessionId, config.redirectUri);
    }
    case 'bearer': {
      if (!config.bearerToken) throw new Error('bearer AuthProvider requires bearerToken.');
      return new BearerAuthProvider(config.bearerToken);
    }
    case 'anonymous': {
      return new AnonymousAuthProvider();
    }
  }
}
```

**Part 3: the three providers each honor the same shape.** Every
provider implements the SDK's `OAuthClientProvider` interface. The
differences are in `tokens()` and in what they throw if OAuth
methods are called unexpectedly.

The bearer strategy (`lib/mcp/auth-providers/bearer.ts:59-67`)
returns a synthetic `OAuthTokens` envelope so the SDK's transport
sends `Authorization: Bearer <token>` without ever running an
OAuth flow:

```ts
tokens(): OAuthTokens | undefined {
  return { access_token: this.token, token_type: 'Bearer' };
}
```

The anonymous strategy (`lib/mcp/auth-providers/anonymous.ts:46-48`)
returns `undefined`, which tells the SDK "no `Authorization` header":

```ts
tokens(): OAuthTokens | undefined {
  return undefined; // no Authorization header will be sent
}
```

The Bloomreach strategy (re-exported from `lib/mcp/auth.ts` via
`lib/mcp/auth-providers/bloomreach.ts`) runs the full OAuth 2.1 +
PKCE + Dynamic Client Registration dance. On first request, the
SDK calls `redirectToAuthorization`, which the provider captures
as `lastAuthorizeUrl`; the `connectMcp` layer catches the
`UnauthorizedError` and returns `{ ok: false, authUrl }` to the
route, which returns 401 with that URL for the browser to
redirect to.

**Part 4: the two throwing paths.** Bearer and anonymous
providers *should never* enter an OAuth flow. If they do
(e.g. the MCP server returns 401 and the SDK tries to
recover), they throw with a message pointing at the fix.
`AnonymousAuthProvider.redirectToAuthorization` at line 54-58:

```ts
redirectToAuthorization(): void {
  throw new Error(
    'AnonymousAuthProvider: redirectToAuthorization called — this provider is
     for MCP servers that do not require authentication. If the server returns
     401, change MCP_AUTH_TYPE.',
  );
}
```

The error text is a debugging affordance. When the wrong strategy
meets a server that expects a different one, the failure names
the fix in the message.

**Part 5: the trust boundary at the MCP URL.** Once
`connectMcp` returns a `StreamableHTTPClientTransport` pointing
at the configured URL, every tool call rides through it, and
whatever token `tokens()` returned goes in the `Authorization`
header. The URL itself is user-configurable via the settings
modal (`McpConfigModal.tsx`). The security note in the modal
copy is honest: bearer tokens in localStorage are less
protected than the `bi_auth` cookie (which is AES-256-GCM
encrypted); the user shouldn't paste production credentials.

### Move 3 — the principle

Strategy-behind-a-factory is the pattern; the interesting piece
here is where the choice comes from. Making the strategy a
per-request UI override — not just an env var — is what turns
"pick your MCP server at deploy time" into "pick your MCP server
in your browser." The trust boundary doesn't move; only the
consent does.

## Primary diagram

```
  Recap — auth boundary end to end

  ┌─ Browser ──────────────────────────────────┐
  │  localStorage['bi:mcp_config']              │
  │    { url, authType, bearerToken }           │
  └────────────┬───────────────────────────────┘
               │ x-bi-mcp-config: base64(JSON)
  ┌─ Route ────▼───────────────────────────────┐
  │  decodeConfigHeader → McpConfigOverride    │
  └────────────┬───────────────────────────────┘
               │
  ┌─ connectMcp ▼──────────────────────────────┐
  │  buildAuthProvider(sessionId, override)    │
  │    type = override?.authType               │
  │        ?? env.MCP_AUTH_TYPE                │
  │        ?? 'oauth-bloomreach'               │
  └────────────┬───────────────────────────────┘
               │
  ┌─ makeAuthProvider ▼────────────────────────┐
  │  switch(type):                              │
  │    'oauth-bloomreach' → Bloomreach          │
  │    'bearer'           → Bearer(token)       │
  │    'anonymous'        → Anonymous           │
  └────────────┬───────────────────────────────┘
               │
  ┌─ Transport ▼───────────────────────────────┐
  │  StreamableHTTPClientTransport(             │
  │    url,                                     │
  │    { authProvider: <picked> }               │
  │  )                                          │
  │  provider.tokens() → Authorization header   │
  └────────────┬───────────────────────────────┘
               │ ═════ trust boundary ═════
  ┌─ MCP server ▼──────────────────────────────┐
  │  sees Authorization: Bearer <token>         │
  │  or no header (anonymous)                   │
  └────────────────────────────────────────────┘
```

## Elaborate

The `OAuthClientProvider` interface comes from the MCP SDK
(`@modelcontextprotocol/sdk`). The SDK designed the surface
around OAuth 2.1 because Anthropic's own Claude Desktop uses
that flow for its MCP connections. Bearer + anonymous
implementations fit the same shape because the transport only
reads `tokens()` — it doesn't require an actual OAuth exchange.
This is the seam that makes the swappable-MCP surface honest:
the strategy pattern already exists in the SDK; this repo just
adds two more concrete implementations behind the shared
factory.

The precedence chain (override → env → default) shows up in
Twelve-Factor apps as "config from env, overridden by CLI
flags." Same idea, one altitude up: config from env, overridden
by a per-request header from the browser.

## Interview defense

**Q: Why not just pass the token as a function argument
everywhere?**

A: The MCP SDK's transport doesn't take a token; it takes a
provider. The provider abstraction is the SDK's, not ours. The
right move is to implement the interface it's designed around,
not to fight it.

**Q: How does the bearer token get to the server?**

A: localStorage → `persistedConfigHeader()` → base64-encoded
JSON in the `x-bi-mcp-config` request header → `decodeConfigHeader`
on the route → `buildAuthProvider` merges override with env →
`makeAuthProvider` constructs `BearerAuthProvider(token)` →
provider's `tokens()` returns `{ access_token: token }` → SDK
transport sends `Authorization: Bearer <token>` to the MCP URL.

**Q: What's the one part people forget about the strategy
pattern here?**

A: The throw-on-unexpected-path. Bearer and anonymous
providers explicitly throw if `redirectToAuthorization` or
`codeVerifier` gets called on them — those are OAuth-only
methods. If the wrong strategy ever meets a server that expects
a different one, the error message names the fix. That's what
turns "silently wrong auth" into "clear enough to debug from
production logs."

**Q: What's the biggest security risk you're accepting?**

A: Bearer tokens in localStorage. They ride the config header
plaintext on every fetch. The `McpConfigModal` surfaces this
warning in the UI copy. The mitigation path is a short-lived
encrypted cookie server-side (called out at
`lib/mcp/config.ts:22-23`) — not done yet.

## See also

- `01-request-flow.md` — how the config header gets to the route
- `03-provider-abstraction-and-datasource-seam.md` — the same
  strategy pattern one layer up (adapter selection)
- `06-per-request-config-transport.md` — the header transport
  in depth
