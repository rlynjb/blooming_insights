# 03 — user-chosen-mcp-url-boundary

**Industry name(s):** User-configurable outbound endpoint; SSRF-adjacent
trust surface; per-request server-side URL override. Type: Project-specific
(the security shape is general; the specific transport is this repo).

## Zoom out — where this concept lives

Session D added a settings modal. The visitor can enter any URL and the
server will make MCP tool calls against it — on their behalf, with their
agent's reasoning behind each call. This is a NEW trust boundary that didn't
exist before Session D. Prior state: Bloomreach loomi alpha, hardcoded.
Current state: whatever URL the visitor pastes, with warnings.

```
  Zoom out — the new boundary Session D creates

  ┌─ Browser ───────────────────────────────────────────────┐
  │  McpConfigModal · localStorage['bi:mcp_config']          │
  │    { url: "https://any-mcp-i-want.example.com/mcp/" }    │
  └────────────────────────┬────────────────────────────────┘
                           │  x-bi-mcp-config header
                           │  (base64-JSON, every request)
  ┌─ Next route ───────────▼────────────────────────────────┐
  │  decodeConfigHeader → validate → makeDataSource         │
  │  ★ NEW TRUST BOUNDARY ★  ← we are here                   │
  │  server decides: honor override or fall through to env   │
  └────────────────────────┬────────────────────────────────┘
                           │  server-side fetch
  ┌─ Provider (arbitrary) ─▼────────────────────────────────┐
  │  ANY MCP SERVER THE VISITOR PICKED                       │
  │  sees every tool call the agent makes                    │
  └─────────────────────────────────────────────────────────┘
```

The bit that's load-bearing: the visitor's browser sends a URL, the server
fetches it. That's the SSRF surface. Not classical (no S3 metadata endpoint
being probed) — but a real "server makes an outbound request to a
user-supplied URL" pattern.

## Structure pass

**Layers.** UI modal (write) → localStorage (persist) → fetch hook (attach
header) → route handler (decode + validate) → `makeDataSource` →
`connectMcp` (build URL, connect) → MCP SDK (drive tool calls).

**Axis: trust — what does the server accept from the client, and what does
it verify itself?**

```
  One axis — trust — traced across the override chain

  UI:      user picks URL + auth type
                    │
                    ▼  header (base64 JSON, per request)
  route:   server DECODES + VALIDATES
                    │      ├─ base64 bad → null (fail-safe to env)
                    │      ├─ JSON bad  → null
                    │      └─ shape bad → null
                    ▼
  factory: server RESOLVES precedence
                    │      1. override.url  ← if valid
                    │      2. MCP_URL env
                    │      3. BLOOMREACH_MCP_URL env (legacy)
                    │      4. hardcoded Bloomreach alpha
                    ▼
  connect: server fetches URL with visitor's auth
```

**Seams that matter.**

  → `decodeConfigHeader` (`lib/mcp/config.ts:87-100`) — the client-suggests /
    server-verifies seam. Everything above is untrusted; everything below
    only proceeds with a validated shape.
  → `buildAuthProvider` (`lib/mcp/connect.ts:148-167`) — the second gate:
    even a validly-shaped override with `authType=bearer` but no token
    throws before the SDK's OAuth machinery starts.

## How it works

Two things stack: (1) the transport that carries the override client-to-server
without polluting the encrypted cookie's threat model, and (2) the
precedence chain the server uses to resolve conflicts.

### Move 1 — the mental model

You know how a `fetch()` call takes an options object and headers? Same idea
here — but the "options" travel from the browser to the server on every
request, encoded so the ASCII-only header transport can carry unicode URLs.

```
  The override kernel — client suggests, server verifies

  browser localStorage             server routes
  ┌────────────────────┐           ┌────────────────────┐
  │ { url, authType,   │           │ 1. read header     │
  │   bearerToken }    │           │ 2. base64 decode   │
  └─────────┬──────────┘           │ 3. JSON parse      │
            │                       │ 4. isMcpConfigOver │
            │  base64(JSON)         │    ride guard      │
            │  attached as          │ 5. normalizeConfig │
            │  x-bi-mcp-config      │    (empty strings) │
            ▼                       │ 6. pass to factory │
       ═══════════ HTTPS ═══════════│                    │
                                    └─────────┬──────────┘
                                              │
                              precedence: override.url >
                              MCP_URL > BLOOMREACH_MCP_URL >
                              hardcoded alpha
                                              ▼
                                     connect + tool calls
```

Two invariants the design enforces:

  → **Server-side wins on validation.** Bad shape → null → fall through to
    env. The client can never force a bad auth-type.
  → **Env is the trust anchor.** UI overrides don't touch other users'
    sessions; they're per-request only.

### Move 2 — the step-by-step walkthrough

**The shape — three optional fields.**

```ts
// lib/mcp/config.ts:27-31
export interface McpConfigOverride {
  url?: string;
  authType?: McpAuthType;      // 'oauth-bloomreach' | 'bearer' | 'anonymous'
  bearerToken?: string;
}
```

All optional so a partial override merges into env defaults — set only `url`
in the UI and `MCP_AUTH_TYPE` env still controls auth.

**Encode — base64 for header transport.**

```ts
// lib/mcp/config.ts:77-82
export function encodeConfigHeader(config: McpConfigOverride): string {
  const json = JSON.stringify(normalizeConfig(config));
  if (typeof btoa === 'function') return btoa(json);
  return Buffer.from(json, 'utf8').toString('base64');
}
```

Headers are ASCII-only by protocol. Base64 lets future non-ASCII URLs
(punycoded internationalized domains) travel safely. Runtime detection
handles browser (`btoa`) and Node (`Buffer`).

**Decode + validate — the trust seam.**

```ts
// lib/mcp/config.ts:87-100
export function decodeConfigHeader(
  header: string | null | undefined,
): McpConfigOverride | null {
  if (!header) return null;
  try {
    const json =
      typeof atob === 'function'
        ? atob(header)
        : Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!isMcpConfigOverride(parsed)) return null;  // ← the guard
    return normalizeConfig(parsed);
  } catch {
    return null;  // ← fail-safe to env
  }
}
```

Three failure modes, one response: null. Bad base64 → null. Bad JSON → null.
Bad shape → null. The route handler treats null as "no override" and falls
through to env. This is the fail-safe design — a malformed header should
never crash a request, and it should never bypass validation and reach the
SDK.

**The type guard — what "bad shape" means.**

```ts
// lib/mcp/config.ts:50-60
export function isMcpConfigOverride(value: unknown): value is McpConfigOverride {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.url !== undefined && typeof v.url !== 'string') return false;
  if (v.authType !== undefined) {
    if (typeof v.authType !== 'string') return false;
    if (!VALID_AUTH_TYPES.has(v.authType as McpAuthType)) return false;  // ★
  }
  if (v.bearerToken !== undefined && typeof v.bearerToken !== 'string') return false;
  return true;
}
```

The ★ line is the load-bearing check — `VALID_AUTH_TYPES` is a
`Set<'oauth-bloomreach' | 'bearer' | 'anonymous'>`. A client-supplied
`authType: "arbitrary"` gets rejected here, so no unknown enum value
reaches `makeAuthProvider`.

**Precedence — where env wins and where override wins.**

```ts
// lib/mcp/connect.ts:38-48
function mcpUrl(override?: McpConfigOverride): URL {
  const raw =
    override?.url ??
    process.env.MCP_URL ??
    process.env.BLOOMREACH_MCP_URL ??
    'https://loomi-mcp-alpha.bloomreach.com/mcp/';
  return new URL(raw.replace(/\/+$/, ''));
}
```

Four-tier chain. Override.url wins when present. Absent → env chain.

**Auth-type resolution has its own guard.**

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

Two guards in one function:

  → `readAuthEnv()` at `lib/mcp/auth-providers/index.ts:44-53` throws at
    process boot if `MCP_AUTH_TYPE=bearer` but `MCP_AUTH_TOKEN` is unset.
    Server-side gate.
  → `buildAuthProvider` throws when the client-side override says bearer
    but no token was supplied. Server-side gate for the per-request path.

Neither gate lets a malformed request reach the SDK's OAuth machinery,
where a missing token would surface as an obscure downstream error.

**The UI warnings that make the trust boundary visible.**

The modal shows two warnings the visitor must read:

```tsx
// components/settings/McpConfigModal.tsx:200-203
⚠ tokens in localStorage are less protected than the encrypted
bi_auth cookie. use test tokens; do not paste production
credentials.
```

```tsx
// components/settings/McpConfigModal.tsx:220-223
⚠ only enter mcp server urls you trust — the server sees every tool
call the agent makes on your behalf.
```

These aren't fine print — they name the two trust decisions the visitor is
making. The first: "your token has weaker at-rest protection than OAuth."
The second: "you're aiming the agent at a target of your choosing; it will
faithfully tell that target everything it does."

### Move 2 variant — the load-bearing skeleton

The kernel: **client suggests → server validates → precedence resolves →
server acts.**

  → Drop the base64 wrap and unicode URLs die on the header transport.
  → Drop the `isMcpConfigOverride` guard and unknown `authType` values reach
    `makeAuthProvider`'s switch statement (which has no default — falls off
    the end with `undefined` behavior).
  → Drop the `normalizeConfig` step and a blank UI field ("") overrides a
    set env var with an empty string. The precedence chain treats "" as
    truthy for `??`, so `MCP_URL` env gets silently ignored.
  → Drop the fail-safe null-return and any malformed header crashes the
    request with a `JSON.parse` throw.

Hardening on top: the UI-side password-input on the bearer token field, the
save-button disable when bearer is selected without a token, the two
warning banners.

**What this doesn't defend against (yet).** The URL itself isn't
scheme/host-allowlisted. A visitor can enter `http://localhost:6379/` (a
Redis instance on the Vercel node's loopback) or `http://169.254.169.254/`
(the AWS instance metadata endpoint). The SDK will attempt to speak MCP-over-
HTTP to it. In practice, neither of those speaks MCP, so the connect fails
fast — but that's coincidence, not defense. A minimal allowlist
(`https:` scheme, no RFC 1918 ranges) would harden this. Called out as a
finding in `audit.md` §8 (SSRF row).

### Move 3 — the principle

**When you accept configuration from an untrusted source, define the
precedence chain FIRST, then define the validation gate at the boundary.**
The precedence chain says who wins on conflict. The validation gate says who
gets to enter the chain at all. Skip either and you either get "server
config silently ignored" or "arbitrary client input reaches privileged code."

## Primary diagram

```
  Full picture — one request from settings-save to tool call

  ┌─ McpConfigModal ─────────────────────────────────────┐
  │  save() → writePersistedConfig({url,authType,token}) │
  │           localStorage['bi:mcp_config']              │
  └─────────────────────┬────────────────────────────────┘
                        │
  ┌─ Client hook ───────▼───────────────────────────────┐
  │  useBriefingStream / useInvestigation                │
  │  header = persistedConfigHeader()                    │
  │  fetch(url, { headers: { 'x-bi-mcp-config': hdr }})  │
  └─────────────────────┬───────────────────────────────┘
                        │  HTTPS
  ┌─ /api/agent route ──▼───────────────────────────────┐
  │  const override = decodeConfigHeader(               │
  │    req.headers.get(BI_MCP_CONFIG_HEADER)            │
  │  );                                                 │
  │                                                     │
  │  ┌─ decode ────────────────────────┐                │
  │  │ base64 → JSON.parse             │  fail → null   │
  │  │ isMcpConfigOverride guard       │  fail → null   │
  │  │ normalizeConfig (strip "")      │                │
  │  └──────────────┬──────────────────┘                │
  │                 │                                   │
  │  makeDataSource(mode, sid, override)                │
  │                 │                                   │
  │  ┌─ connectMcp ▼──────────────────────────────────┐ │
  │  │ mcpUrl(override):                              │ │
  │  │   override.url ?? MCP_URL ?? BLOOMREACH_MCP_URL │ │
  │  │   ?? 'loomi-alpha default'                     │ │
  │  │                                                │ │
  │  │ buildAuthProvider(sid, override):              │ │
  │  │   type = override.authType ?? env.type         │ │
  │  │   if bearer && !token: throw                   │ │
  │  │   makeAuthProvider(...)                        │ │
  │  └────────────────┬───────────────────────────────┘ │
  │                   │                                 │
  │            transport.connect(mcpUrl, authProvider)  │
  └───────────────────┬─────────────────────────────────┘
                      │  Authorization: Bearer <...>
  ┌─ Chosen MCP server ▼────────────────────────────────┐
  │  sees every tool call the agent will make           │
  └─────────────────────────────────────────────────────┘
```

## Elaborate

Where the pattern comes from: this is the "BYO endpoint" shape from Stripe
Connect, GitHub webhook targets, Zapier destinations — anywhere a platform
lets a user aim it at their own endpoint. The always-there tension: the
user's convenience (I want to point this at MY server) vs the platform's
safety (that server sees my traffic).

Adjacent security categories:

  → **SSRF (Server-Side Request Forgery).** Classic version: attacker
    supplies a URL, server fetches it, server leaks response body or
    metadata. This repo's shape is milder — the SDK expects MCP-over-HTTP,
    so a `http://169.254.169.254/latest/meta-data/` request gets attempted
    but the response isn't returned to the client raw. The MCP protocol
    layer filters what comes back. Still: worth an allowlist.
  → **Confused deputy.** The server acts on behalf of a user, using its own
    credentials, but the user chose the target. This repo mitigates by NOT
    using its own credentials — the visitor supplies their own token.
    Confused-deputy risk is genuinely low here.
  → **Data exfiltration via tool calls.** A malicious MCP server can return
    tool results that look like prompt-injection payloads, steering the
    agent to make more calls that leak conversation state. This is where
    per-agent tool scope (`audit.md` §7 finding 7.1) would help.

## Interview defense

**Q: What actually stops a visitor from pointing this at anything?**

A: Nothing at the URL layer today — that's a real gap I called out in the
audit. The visitor picks the URL; the server fetches it. The mitigations we
DO have are: two visible UI warnings that name the trust decision, a fail-safe
decode that falls through to env config on any malformed header, and a
validation gate that rejects unknown `authType` values before they reach
`makeAuthProvider`. What's missing: a scheme + host allowlist that would keep
outbound requests from hitting `localhost:6379` or the cloud metadata
endpoint. The fix is a preflight check on `override.url` in `mcpUrl()` —
reject if the scheme isn't `https:` or the host is in an RFC 1918 range or
matches a metadata IP.

```
  Layered defenses (want): allowlist scheme + host
                            ↓
                           validate shape (isMcpConfigOverride) ✓
                            ↓
                           validate token presence (buildAuthProvider) ✓
                            ↓
                           MCP protocol strips unrelated responses (SDK)
```

Anchor: `lib/mcp/connect.ts:38-48` (mcpUrl) and
`lib/mcp/config.ts:50-60` (guard).

**Q: Why is the header per-request instead of a cookie?**

A: The `bi_auth` cookie's threat model is "AES-256-GCM ciphertext of OAuth
state, HttpOnly, sameSite=none, 10-day lifetime." That discipline exists
because OAuth tokens are high-value and long-lived. A bearer test token or
an arbitrary MCP URL doesn't need — and shouldn't inherit — that
discipline. Keeping the override in localStorage means: the visitor's own
token, in their own browser, under their control. They can clear it any
time. The cookie stays reserved for what it was designed to hold.

The tradeoff: bearer tokens travel as base64-in-header on every fetch,
plaintext (over TLS). If someone MITMs the TLS or gets a memory dump of
localStorage, the token leaks. That's why the UI says "use test tokens; do
not paste production credentials."

Anchor: `lib/mcp/config.ts:14-22` (the module-doc that spells this out) and
`components/settings/McpConfigModal.tsx:200-203` (the UI warning).

**Q: What's the precedence chain and why does it matter?**

A: Four tiers, top to bottom:

```
  1. override.url            per-request, from UI localStorage
  2. process.env.MCP_URL     env, current name
  3. process.env.BLOOMREACH_MCP_URL   env, legacy name
  4. hardcoded loomi-alpha URL       default
```

The matter: env is the trust anchor. If a deploy env sets `MCP_URL`, an
individual visitor's UI override wins for THEIR request only — never for
other users' sessions. If a visitor doesn't override, the deploy's env
takes effect. If nothing's set anywhere, the app still works out of the
box against the default. That's what "server-side wins on validation, env
is the trust anchor" means concretely.

Anchor: `lib/mcp/connect.ts:38-48`.

## See also

- `04-server-side-config-validation.md` — the decode/guard/normalize seam in depth
- `01-encrypted-auth-cookie.md` — why bearer NEVER lands in the encrypted cookie
- `06-secret-redaction-in-errors.md` — how a leaked-bearer error stays out of logs
