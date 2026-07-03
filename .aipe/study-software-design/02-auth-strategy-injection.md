# auth-strategy pattern via injection

## Subtitle

**Strategy pattern with dependency injection** (three auth flows behind one interface, factory-selected by discriminant). *Industry standard.*

Role-vocabulary this file uses:

```
  strategy  the interchangeable algorithm       (OAuthClientProvider from the MCP SDK)
  context   code that uses the strategy         (StreamableHTTPClientTransport)
  policy    the discriminant that selects       ('oauth-bloomreach' | 'bearer' | 'anonymous')
  factory   picks + constructs the strategy     (makeAuthProvider)
  DI        passes the strategy to the context  (transport constructor's authProvider option)
```

## Zoom out — where this concept lives

The MCP SDK's transport (`StreamableHTTPClientTransport`) needs to know how to authenticate every HTTP call. It doesn't hard-code OAuth 2.1; it accepts an `authProvider` object that implements a small interface (`OAuthClientProvider` — 10 methods). Anything that satisfies the shape works — full OAuth PKCE DCR flow, static bearer token, no auth at all. That's the strategy pattern with dependency injection.

```
  the auth strategy — where it sits inside the port stack

  ┌─ Client (agents) ──────────────────────────────────────────┐
  │  hold a DataSource — no idea auth even exists              │
  └────────────────────────┬───────────────────────────────────┘
                           │
  ┌─ DataSource port ─────▼───────────────────────────────────┐
  │  callTool / listTools — no auth in the signature          │
  └────────────────────────┬───────────────────────────────────┘
                           │
  ┌─ MCP adapter ─────────▼───────────────────────────────────┐
  │  BloomreachDataSource(new SdkTransport(client, holder))   │
  └────────────────────────┬───────────────────────────────────┘
                           │
  ┌─ MCP SDK transport ───▼───────────────────────────────────┐
  │  StreamableHTTPClientTransport({ authProvider })          │ ← we are here
  │       │                                                    │
  │       └── OAuthClientProvider interface (10 methods)      │
  │             │                                              │
  │  ┌──────────┼──────────────┐──────────────────────────┐   │
  │  │          │              │                          │   │
  │  ▼          ▼              ▼                          ▼   │
  │ Bloomreach  Bearer         Anonymous               (factory)│
  │ (OAuth      (static        (no auth               makeAuth  │
  │  PKCE DCR)  token)         header)                Provider) │
  └────────────────────────────────────────────────────────────┘
```

The strategy pattern is nested inside the port pattern from file 01. The port hides "which backend"; this strategy hides "which auth flow."

## Zoom in — what this pattern is

`OAuthClientProvider` is the strategy interface (defined by the MCP SDK — not owned by this codebase). Three implementations live in `lib/mcp/auth-providers/`:

- `BloomreachAuthProvider` — full OAuth 2.1 + PKCE + Dynamic Client Registration, session-persisted via encrypted cookie
- `BearerAuthProvider` — static token in the `Authorization` header
- `AnonymousAuthProvider` — no `Authorization` header at all

`makeAuthProvider({type, ...})` picks by discriminant. The consumer (`connectMcp` in `lib/mcp/connect.ts:82-140`) doesn't know which one it got.

## Structure pass — skeleton first

### Axes

The right axis to trace here is **"where does the credential come from?"**

- `oauth-bloomreach` → **from a session-persisted OAuth flow** (encrypted cookie holds PKCE verifier + client info + tokens across requests)
- `bearer` → **from an env var or a per-request UI override** (localStorage → base64 header → server-side decode)
- `anonymous` → **from nowhere** (no credential; the MCP server accepts unauthed calls)

Same "credential source" question, three completely different answers. The seam is where the answer changes — right at the `authProvider` reference passed to the transport.

### Seams

The load-bearing seam: `OAuthClientProvider` interface. Above it, the SDK transport reads `provider.tokens()` and stamps `Authorization` on every HTTP call. Below it, one of three concrete implementations returns a token (or `undefined`, or a specific-shape `OAuthTokens`).

The secondary seam: `makeAuthProvider` — the factory boundary. Above it: `connectMcp` passes `{type, sessionId, redirectUri, bearerToken}`. Below it: one specific class is `new`'d. Only place that knows the class names.

### Layered decomposition

Hold "what happens when the token is missing/expired?" constant:

- Anonymous: **the SDK gets `undefined`** → no `Authorization` header → the server 401s if it needs auth → `redirectToAuthorization` throws with a clear message ("this provider is for MCP servers that do not require authentication").
- Bearer: **the SDK gets the passed-in token** → if the server rejects it (401), `redirectToAuthorization` throws with a clear message ("either the token is invalid or the MCP server expects a real OAuth flow").
- Bloomreach: **the SDK gets the current session's tokens** (from encrypted cookie) → if none, the SDK's OAuth flow calls `redirectToAuthorization` which captures the authorize URL → `connectMcp` catches the throw and returns `{ ok: false, authUrl }` so the route can redirect the browser.

Same question, three answers, all bounded by the same interface. That's what the strategy pattern buys.

## How it works

### Move 1 — the mental model

Think of the strategy pattern like the plug on the back of a router. The router (the SDK transport) has a port for a power supply; anything with the right plug fits. A wall wart works. A USB-C from your laptop works. A battery pack works. The router doesn't know which is behind the port. Here, `OAuthClientProvider` is that plug shape; the three provider classes are three different power supplies.

```
  the shape of the pattern — one interface, N implementations, factory selects

  ┌───────────────────────────────────┐
  │  StreamableHTTPClientTransport    │  ← the context
  │    reads authProvider.tokens()    │     doesn't know which
  │    on every HTTP call             │     provider fired
  └──────────────┬────────────────────┘
                 │
                 │  authProvider: OAuthClientProvider
                 ▼
        ┌────────────────┐
        │ 10-method      │
        │ interface      │  ← the strategy
        │ (from MCP SDK) │
        └───┬────┬────┬──┘
            │    │    │
       impl │    │    │ impl
            │    │    │
            ▼    ▼    ▼
     Bloomreach  Bearer  Anonymous
     — OAuth   — static  — no
       PKCE      token     Auth
       DCR                 header
       session
       persist

     factory:  makeAuthProvider({ type, sessionId, redirectUri, bearerToken })
```

### Move 2 — the walkthrough

Four moving parts: the strategy interface (a contract owned by the SDK), the three concrete strategies, and the factory.

#### The strategy interface — `OAuthClientProvider`

Not defined by this codebase — imported from `@modelcontextprotocol/sdk/client/auth.js`. The relevant surface (10 methods):

```
  redirectUrl           string         — where the OAuth flow returns to
  clientMetadata        object          — for Dynamic Client Registration
  state()               string          — CSRF token
  clientInformation()   maybe object    — the registered client info
  saveClientInformation() void          — persist client info (post-DCR)
  tokens()              maybe OAuth     — the current tokens; SDK calls this
  saveTokens()          void            — persist tokens (post-exchange)
  redirectToAuthorization() void        — build the authorize URL + throw
  saveCodeVerifier()    void            — persist PKCE verifier
  codeVerifier()        string          — read PKCE verifier
```

**Not owned by this repo — that's the point.** The strategy shape is the SDK's contract; every implementation in this repo satisfies it. The SDK is the boundary.

#### The three strategies

Live in `lib/mcp/auth-providers/`. Each is one file.

**`BloomreachAuthProvider`** — the full flow. The class body lives at `lib/mcp/auth.ts:1-259` (the 16-LOC `bloomreach.ts` is a re-export; see `03-rename-via-reexport.md` for why). Implements every method for real: DCR happens at connect time via `clientMetadata` + `saveClientInformation`, the OAuth code exchange in the callback route reads the PKCE verifier via `codeVerifier`, and tokens live in the AES-256-GCM encrypted cookie via `saveTokens` (production) or a gitignored file (dev). This is the only provider whose methods do real work; the other two are mostly no-ops.

**`BearerAuthProvider`** — 88 LOC at `lib/mcp/auth-providers/bearer.ts`. The interesting parts:

```typescript
// lib/mcp/auth-providers/bearer.ts:26-31
export class BearerAuthProvider implements OAuthClientProvider {
  constructor(private readonly token: string) {
    if (!token) {
      throw new Error('BearerAuthProvider requires a non-empty token.');
    }
  }
```

Guard: constructing without a token throws immediately. The factory checks earlier (in `makeAuthProvider`), but the guard here is the last line of defense.

```typescript
// lib/mcp/auth-providers/bearer.ts:59-67
tokens(): OAuthTokens | undefined {
  return {
    access_token: this.token,
    token_type: 'Bearer',
  };
}
```

The SDK reads this and stamps `Authorization: Bearer <token>` on every request. Everything else — `saveTokens`, `saveClientInformation`, `saveCodeVerifier`, etc. — is a no-op. Bearer has no flow to persist.

```typescript
// lib/mcp/auth-providers/bearer.ts:73-77
redirectToAuthorization(): void {
  throw new Error(
    'BearerAuthProvider: redirectToAuthorization called — a bearer-token provider is expected to have a valid token from the start. If the server returned 401, either the token is invalid or the MCP server expects a real OAuth flow (change MCP_AUTH_TYPE to oauth-bloomreach).',
  );
}
```

The methods that don't apply throw with actionable error messages. That's the deep-module discipline — errors say what to do about them.

**`AnonymousAuthProvider`** — 69 LOC at `lib/mcp/auth-providers/anonymous.ts`. Simpler still:

```typescript
// lib/mcp/auth-providers/anonymous.ts:46-48
tokens(): OAuthTokens | undefined {
  return undefined;  // no Authorization header will be sent
}
```

Returning `undefined` tells the SDK to skip the header entirely. All persistence methods are no-ops. All flow methods throw ("this provider is for MCP servers that do not require authentication").

**What breaks if you remove any strategy:**

- Remove `BloomreachAuthProvider`: no way to talk to the alpha loomi connect server (the whole demo pipeline breaks).
- Remove `BearerAuthProvider`: no way to talk to any MCP server that uses pre-issued tokens (personal access tokens, API keys, service tokens).
- Remove `AnonymousAuthProvider`: no way to talk to local dev MCP servers, public MCP servers, or in-cluster MCP servers.

Each shape corresponds to a real class of MCP server. Adding a fourth (e.g. a per-request signed JWT) would take one more file and one more case in the factory.

#### The factory — `makeAuthProvider`

`lib/mcp/auth-providers/index.ts:56-76`, side-by-side:

```typescript
export function makeAuthProvider(config: McpAuthConfig): OAuthClientProvider {
  //                                                     ▲ the return type is the STRATEGY
  //                                                       (SDK interface), not a concrete class
  switch (config.type) {
    case 'oauth-bloomreach': {
      if (!config.sessionId || !config.redirectUri) {
        throw new Error(
          'oauth-bloomreach AuthProvider requires sessionId + redirectUri.',
        );
      }
      return new BloomreachAuthProvider(config.sessionId, config.redirectUri);
    }
    case 'bearer': {
      if (!config.bearerToken) {
        throw new Error('bearer AuthProvider requires bearerToken.');
      }
      return new BearerAuthProvider(config.bearerToken);
    }
    case 'anonymous': {
      return new AnonymousAuthProvider();
    }
  }
}
```

**What the factory does:**

1. **Names the concrete classes.** The only file that references `BloomreachAuthProvider`, `BearerAuthProvider`, `AnonymousAuthProvider` in a `new` position outside their own file. The consumer sees `OAuthClientProvider`.
2. **Validates the config shape.** Each case checks the fields *it* needs and throws with a specific error. The signature `(config: McpAuthConfig): OAuthClientProvider` doesn't encode "some fields are optional depending on `type`" — TypeScript's discriminant unions could, but the current shape uses runtime guards. Deliberate: the config also arrives from an untyped HTTP header (the UI override), so runtime validation is unavoidable anyway.
3. **Returns typed as the interface.** The consumer sees `OAuthClientProvider` and cannot narrow to a concrete class without an explicit `instanceof` check.

That last point matters. Grep the codebase for `instanceof BloomreachAuthProvider`:

```
lib/mcp/connect.ts:133      if (provider instanceof BloomreachAuthProvider && provider.lastAuthorizeUrl) {
```

**One place**. The catch block in `connectMcp` reaches back for `lastAuthorizeUrl` — a property only the OAuth provider has (bearer and anonymous throw instead of capturing a URL). That `instanceof` is deliberate: it's the "OAuth flow interrupted, capture the redirect URL" path. Bearer + anonymous can't produce that path; the guard makes it visible.

Every other consumer site treats the return as opaque `OAuthClientProvider`. That's the strategy pattern's contract holding.

### Move 2.5 — Phase A vs Phase B

**Phase A** (pre-Session B): `BloomreachAuthProvider` was baked into `connectMcp` directly. The MCP URL was hard-coded to Bloomreach's alpha endpoint. Trying it against any other MCP server required editing the class.

**Phase B** (Session B, current): three providers behind the factory; the consumer picks by config discriminant. Env-driven default (`MCP_AUTH_TYPE=oauth-bloomreach` → the historical behavior, backward compat preserved). Per-request UI override from Session D layers on top (see `04-client-server-contract-module.md`).

```
  Phase A                                Phase B
  ───────                                ───────
                                         ┌─ config ─┐
  ┌─ connectMcp ─┐                        │ type:    │
  │   hard-       │                        │  oauth-  │
  │   coded:      │                        │  bloom / │
  │   new         │                        │  bearer /│
  │   Bloomreach  │                        │  anon    │
  │   AuthProv.   │                        └────┬─────┘
  └───────────────┘                             │
                                                ▼
                                         ┌─ makeAuthProvider ─┐
                                         │  switch(type)     │
                                         └──┬───┬───┬──────────┘
                                            │   │   │
                                            ▼   ▼   ▼
                                         3 providers,
                                         chosen at
                                         request time
```

Migration cost: exactly one caller change (`connectMcp` moved from `new BloomreachAuthProvider(...)` to `makeAuthProvider({...})`). Everything else — the SDK transport, the tests, the MCP adapter — was untouched. Same interface, new upstream selector.

### Move 3 — the principle

**The principle:** when a single decision has N answers that must all satisfy the same downstream contract, extract a strategy interface and let a factory pick the answer. The upstream (the context — here, the SDK transport) doesn't grow N branches; the downstream (the strategy — here, `tokens()` returning different shapes) does.

The signature "wildly different behavior behind a small, uniform interface" is exactly the deep-module win from file 01, at a different scope. Where file 01 hides four external-boundary shapes behind two methods, this file hides three auth-flow shapes behind ten. Same test: how many callers grow branches when a new strategy arrives? Here, one — `makeAuthProvider` grows one `case`. The SDK transport, the MCP adapter, and the agents grow nothing.

## Primary diagram

```
  the strategy family in one picture — with what each provider actually implements

  ┌──────────────────────── OAuthClientProvider (SDK interface) ──────────────────────┐
  │  10 methods:                                                                       │
  │    redirectUrl · clientMetadata · state · clientInformation ·                     │
  │    saveClientInformation · tokens · saveTokens · redirectToAuthorization ·         │
  │    saveCodeVerifier · codeVerifier                                                 │
  └───────────┬──────────────────────────┬────────────────────────────┬────────────────┘
              │                          │                            │
       implements                  implements                    implements
              │                          │                            │
              ▼                          ▼                            ▼
  ┌─ Bloomreach ────────────┐  ┌─ Bearer ──────────────┐  ┌─ Anonymous ──────────────┐
  │  259 LOC (in auth.ts)    │  │  88 LOC                │  │  69 LOC                   │
  │  OAuth 2.1 + PKCE + DCR  │  │  static token          │  │  no header at all         │
  │  encrypted cookie store  │  │  no persistence        │  │  no persistence           │
  │  session-scoped tokens   │  │  guards non-empty token│  │  guards against OAuth     │
  │  captures authorize URL  │  │  throws with hint on   │  │  throws with hint on      │
  │  in `lastAuthorizeUrl`   │  │  redirectToAuth call   │  │  redirectToAuth call      │
  │  used by: connect.ts:133 │  │                        │  │                           │
  │  (the ONE instanceof)    │  │  used by: no direct    │  │  used by: no direct       │
  │                          │  │  instanceof anywhere   │  │  instanceof anywhere      │
  └──────────────────────────┘  └────────────────────────┘  └───────────────────────────┘
              ▲                          ▲                            ▲
              │                          │                            │
              └──────────────────────────┼────────────────────────────┘
                                         │
                        ┌────────────────┴───────────────┐
                        │  makeAuthProvider (factory)    │
                        │  switch by config.type          │
                        │  the ONLY code that names       │
                        │  concrete provider classes      │
                        │  in a `new` position            │
                        └────────────────┬───────────────┘
                                         │
                                         │ returns OAuthClientProvider
                                         ▼
                        ┌───────────────────────────────┐
                        │  connectMcp (the client)      │
                        │  passes provider to           │
                        │  StreamableHTTPClientTransport │
                        │  as authProvider option        │
                        └───────────────────────────────┘

  what each provider actually does when the SDK calls tokens():
    Bloomreach → reads encrypted cookie, returns current session's OAuthTokens
    Bearer     → returns { access_token: this.token, token_type: 'Bearer' }
    Anonymous  → returns undefined (no Authorization header stamped)
```

## Elaborate

**Where the pattern comes from.** Strategy is one of the original Gang of Four patterns (1994). The specific shape used here — an interface owned by an SDK, with the application supplying concrete implementations — is common in plugin architectures and drivers (JDBC's `Driver` interface, Node.js stream interfaces, MCP's own transport interface). The value is that the SDK doesn't have to know what auth flow you use; it just calls the interface.

**What problem the shape solves for this repo.** The MCP SDK models auth as "you supply an object that implements this contract." Before Session B, this codebase hard-coded that object to be Bloomreach OAuth — the whole class was constructed inline in `connectMcp`. The consequence: to try a bearer-authed MCP server (like a personal access token), you had to edit the class. Now: change `MCP_AUTH_TYPE=bearer` and set `MCP_AUTH_TOKEN` (or set them per-request via the UI override; see `04-client-server-contract-module.md`).

**Why the guard/throw pattern is deliberate.** `BearerAuthProvider.redirectToAuthorization` throws instead of silently returning. That looks like a bug at first — why not just no-op? Because if the SDK ever calls it, something upstream is broken (the server unexpectedly required OAuth, the token was invalid, the type discriminant is wrong). Throwing with a hint is *how* the deep module tells the caller what went wrong. Silent no-ops hide the failure.

**Adjacent concepts.**

- **Port/adapter** — the strategy pattern is a port with N adapters at a nested level. File 01 is the outer port (`DataSource`); this file is a nested port (`OAuthClientProvider`).
- **Factory method** — same as file 01. `makeAuthProvider` is the classical factory: returns instances typed as the interface, so callers never name concrete classes.
- **Null Object** — `AnonymousAuthProvider` is close to a Null Object: the "do nothing" implementation of an interface that satisfies the shape without doing anything. Slight difference: it throws (not no-ops) on the OAuth entry point, so a misconfiguration is caught loudly.

## Interview defense

### Q: Walk through what happens when `MCP_AUTH_TYPE=bearer` is set and the token is missing.

**Answer:** Two guards fire, in order.

1. `readAuthEnv()` at `lib/mcp/auth-providers/index.ts:44-53` reads `process.env.MCP_AUTH_TYPE`, sees `'bearer'`, tries to read `MCP_AUTH_TOKEN`, and if it's undefined, throws immediately with the message "MCP_AUTH_TYPE=bearer requires MCP_AUTH_TOKEN."
2. If somehow that check is bypassed (e.g. a UI override sends `authType: 'bearer'` with no `bearerToken`), the factory's second guard fires at `makeAuthProvider` — the `case 'bearer'` block checks `config.bearerToken` and throws "bearer AuthProvider requires bearerToken."
3. And if that's bypassed, the `BearerAuthProvider` constructor throws "BearerAuthProvider requires a non-empty token."

Three guards, three layers, each with an actionable message. The design is that a misconfigured deployment fails loudly at boot, not silently at first request.

Anchor: *lib/mcp/auth-providers/index.ts:44-53 (env guard), :66-70 (factory guard), lib/mcp/auth-providers/bearer.ts:27-31 (constructor guard).*

### Q: The consumer does an `instanceof BloomreachAuthProvider` check in `connectMcp`. Doesn't that violate the strategy pattern?

**Answer:** No — it's the OAuth-specific escape hatch, and it's the *only* place in the codebase that reaches for a concrete provider type. The reason it exists: the SDK's `redirectToAuthorization` throws instead of returning the authorize URL (that's how OAuth SDKs typically surface "I need the user to redirect"). To catch the throw and turn it into `{ ok: false, authUrl }` for the route to consume, `connectMcp` needs the URL — and only the OAuth provider has one (`lastAuthorizeUrl`).

The alternative would be lifting `lastAuthorizeUrl` onto the base interface, but then Bearer and Anonymous providers would have to expose a field that never fires. That's a shallow-module smell — widening the interface for one implementation.

The `instanceof` is a real edge case at a well-named boundary; that's honest, not a violation. The strategy pattern says "the context doesn't branch on concrete type during normal operation." `connectMcp` doesn't — every `callTool` in normal flow just calls the interface. The `instanceof` fires only inside the OAuth-specific error path.

Anchor: *lib/mcp/connect.ts:132-136 — the one `instanceof`, inside a catch, guarded to fire only when the OAuth flow interrupted.*

### Q: Why not use TypeScript discriminated unions for `McpAuthConfig` instead of runtime guards?

**Answer:** Two reasons.

1. The config arrives from an untyped HTTP header (the UI override — see `04-client-server-contract-module.md`). No matter what TypeScript encodes, the header contents are `unknown` at the runtime boundary. Runtime guards would still be necessary.
2. Discriminated unions would make the factory *shape* stricter (each case would prove its own field is present), but the runtime checks are the actual defense. Stacking both would be duplication.

That said — if this codebase ever hits a third case where the interface widens to a fourth or fifth strategy, the discriminated union starts pulling weight (compile-time exhaustiveness on the `switch`). For three cases with hand-authored guards, runtime is fine.

Anchor: *lib/mcp/auth-providers/index.ts:25-34 — the `McpAuthConfig` shape today; all fields optional except `type`.*

## See also

- [audit.md](./audit.md) — lens 2 names `makeAuthProvider` as a runner-up deepest module; lens 6 names the throw-with-actionable-message pattern as a small deep-module win.
- [01-port-adapter-decorator-preset-factory.md](./01-port-adapter-decorator-preset-factory.md) — the outer port (`DataSource`) with the same strategy shape at a wider scope; this file is a strategy nested inside that port.
- [03-rename-via-reexport.md](./03-rename-via-reexport.md) — why `BloomreachAuthProvider`'s body lives in `lib/mcp/auth.ts` while `lib/mcp/auth-providers/bloomreach.ts` re-exports it.
- [04-client-server-contract-module.md](./04-client-server-contract-module.md) — how the UI override reaches the factory via base64 header.
- `.aipe/read-aposd/` (chapter on Different Layer, Different Abstraction) — the strategy is one layer above the SDK transport; different abstraction at each altitude.
