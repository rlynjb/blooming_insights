# 04 — server-side-config-validation

**Industry name(s):** Server-side input validation (untrusted-input-crossing-
boundary pattern); type guard / structural validator; fail-safe defaults.
Type: Industry standard.

## Zoom out — where this concept lives

Between the client (which supplies the MCP config override) and the SDK
(which acts on it) sits the validator seam. Nothing untrusted reaches the
SDK without passing through it.

```
  Zoom out — where the guard sits

  ┌─ UI (browser) ────────────────────────────────────┐
  │  localStorage → base64(JSON) → header             │
  └────────────────────┬──────────────────────────────┘
                       │
  ┌─ Next route ───────▼─────────────────────────────┐
  │  decodeConfigHeader:                              │
  │    ★ isMcpConfigOverride guard ★  ← we are here   │
  │    normalizeConfig                                │
  └────────────────────┬─────────────────────────────┘
                       │  validated shape (or null)
  ┌─ makeDataSource + connectMcp + SDK ▼────────────┐
  │  never sees a client-supplied `authType` that    │
  │  wasn't in VALID_AUTH_TYPES                      │
  └──────────────────────────────────────────────────┘
```

The pattern: don't trust the wire. Verify shape at entry; fall through
safely on failure.

## Structure pass

**Layers.** header (bytes) → base64 decode → JSON parse → type guard →
normalize → factory.

**Axis: trust — treat every layer above the guard as hostile.**

```
  One axis — trust — flips at the guard

  header:    HOSTILE — arbitrary bytes
      │
  base64:    HOSTILE — decoded string, no shape
      │
  JSON:      HOSTILE — parsed value, could be anything
      │
  ─────── isMcpConfigOverride ───────  ★ trust flips here ★
      │
  narrowed:  TRUSTED shape (McpConfigOverride)
      │
  normalized: TRUSTED + coerced (empty strings → undefined)
      │
  factory:   builds AuthProvider with confidence
```

**Seam that matters.** `isMcpConfigOverride` at `lib/mcp/config.ts:50-60`.
It's a TypeScript type predicate (`value is McpConfigOverride`) — after it
returns true, downstream code sees the narrowed type. Before it, everything
is `unknown`. That flip is the boundary.

## How it works

The pattern is a type guard function that runs field-by-field checks,
returning true only when every field is either absent or matches the
expected type. Downstream code depends on TypeScript's `is` predicate to
carry the guarantee.

### Move 1 — the mental model

You've written `Array.isArray(x)` before. That's a type predicate: it
returns a boolean AND narrows TypeScript's understanding of `x` for the
rest of the block. `isMcpConfigOverride` is the same shape but for a
nested object.

```
  The type-guard kernel — narrow on true, pass through on false

  input: unknown
      │
      ▼
  ┌─ is it an object? ─────────────┐
  │   no  → return false            │
  │   yes → continue                │
  └──────────────┬─────────────────┘
                 ▼
  ┌─ for each field ───────────────┐
  │   is it undefined? → skip       │
  │   is it the right type? → yes   │
  │   is it in the enum set? → yes  │
  │   otherwise → return false      │
  └──────────────┬─────────────────┘
                 ▼
  return true
  → caller now sees narrowed type
```

Field-by-field, allowing optional fields to be absent. Every field either
matches its type OR is undefined.

### Move 2 — the step-by-step walkthrough

**The allowed enum values live in a Set.**

```ts
// lib/mcp/config.ts:41-45
const VALID_AUTH_TYPES = new Set<McpAuthType>([
  'oauth-bloomreach',
  'bearer',
  'anonymous',
]);
```

A `Set<McpAuthType>` gives you O(1) membership check AND ties the runtime
list to the compile-time union. Adding a fourth `McpAuthType` value in the
future forces this set to include it (TypeScript will flag any subset
mismatch).

**The guard, field by field.**

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

Trace it — what happens when `value = { url: "https://x", authType: "hacked" }`?

```
  Execution trace — hostile authType

  step 1: value === null?  no
          typeof === 'object'?  yes → continue
  step 2: v = value cast to Record<string, unknown>
  step 3: v.url = "https://x", not undefined, typeof === 'string' → ok
  step 4: v.authType = "hacked", not undefined, typeof === 'string' → ok
          VALID_AUTH_TYPES.has("hacked")?  NO → return false ★
  ← caller sees false; falls through to null
```

What about `value = { authType: 42 }` (wrong type entirely)?

```
  Execution trace — non-string authType

  step 1: value === null?  no
          typeof === 'object'?  yes → continue
  step 2: v = value cast to Record<string, unknown>
  step 3: v.url = undefined, first branch (!== undefined) fails → skip
  step 4: v.authType = 42, not undefined
          typeof 42 === 'string'?  NO → return false ★
```

Every hostile input falls off at the first failing check.

**Fail-safe on any decoding error.**

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
    return null;  // ← ANY throw becomes null
  }
}
```

Three failure classes, one response:

  → Bad base64 → `atob` throws → catch → null
  → Bad JSON → `JSON.parse` throws → catch → null
  → Bad shape → guard returns false → early return null

Every one falls through to env config downstream. The design principle: a
malformed header should NEVER crash the request AND should NEVER bypass
the validation. Both invariants hold by the same mechanism — the null return.

**normalizeConfig — the "empty string is undefined" rule.**

```ts
// lib/mcp/config.ts:63-70
export function normalizeConfig(config: McpConfigOverride): McpConfigOverride {
  return {
    url: config.url && config.url.trim() ? config.url.trim() : undefined,
    authType: config.authType,
    bearerToken:
      config.bearerToken && config.bearerToken.trim()
        ? config.bearerToken.trim()
        : undefined,
  };
}
```

Why this exists: the precedence chain in `mcpUrl()`
(`lib/mcp/connect.ts:38-48`) uses `??` for nullish-coalescing.
`"" ?? env` returns `""`, not `env`. If the visitor clears the URL field
and hits save without normalize, the empty string clobbers the env value.
Trim + coerce-to-undefined restores env-fallback behavior.

**Where the guard actually runs.** Every route that touches MCP calls it:

```ts
// app/api/agent/route.ts:165
const mcpConfigOverride = decodeConfigHeader(req.headers.get(BI_MCP_CONFIG_HEADER));
```

Same line pattern in `/api/briefing/route.ts`. The output flows into
`makeDataSource(mode, sid, mcpConfigOverride)`. The factory hands it to
`connectMcp`. `connectMcp` uses it in `mcpUrl()` and `buildAuthProvider()`.

**Two enforcement points — belt-and-braces.** The guard is the first
enforcement. The factory then has its OWN error path:

```ts
// lib/mcp/auth-providers/index.ts:44-53
export function readAuthEnv(): { type: McpAuthType; bearerToken?: string } {
  const type = parseAuthType(process.env.MCP_AUTH_TYPE);
  const bearerToken = type === 'bearer' ? process.env.MCP_AUTH_TOKEN : undefined;
  if (type === 'bearer' && !bearerToken) {
    throw new Error(
      'MCP_AUTH_TYPE=bearer requires MCP_AUTH_TOKEN. Set it in env, or change MCP_AUTH_TYPE.',
    );
  }
  return { type, bearerToken };
}
```

```ts
// lib/mcp/connect.ts:156-160
if (type === 'bearer' && !bearerToken) {
  throw new Error(
    'bearer auth type selected but no token provided — set one in Settings or via MCP_AUTH_TOKEN env.',
  );
}
```

Two throws for the same class of error, at two different layers. `readAuthEnv`
catches env misconfiguration at process boot. `buildAuthProvider` catches
the per-request path (UI override says bearer but supplied no token). Both
throws land before the SDK's OAuth machinery, so the failure is loud and
early instead of surfacing as a strange downstream error.

### Move 2 variant — the load-bearing skeleton

The kernel: **null on any failure + narrow on success + normalize before use.**

  → Drop the try/catch and any bad input crashes the request.
  → Drop the type predicate and downstream code doesn't get narrowing;
    every downstream access has to cast/re-check.
  → Drop the enum-set membership check and unknown `authType` values reach
    the factory's switch statement (which has no default case — falls off
    the end returning undefined).
  → Drop the normalize step and blank UI fields clobber env config.
  → Drop the double-throw pattern (readAuthEnv + buildAuthProvider) and
    the "bearer selected but no token" case reaches the SDK as an
    unauthorized bearer header the MCP server rejects with a confusing
    401.

Hardening on top: the UI save-button disable that keeps this state from
being persisted in the first place (`components/settings/McpConfigModal.tsx:277`).

### Move 3 — the principle

**Validation at the trust boundary; narrowing at the type level.** The
principle is neither validation alone (which leaves `unknown` types
downstream, inviting re-checks) nor narrowing alone (which trusts the
compiler over the wire, unsound). It's both, coupled with a fail-safe
default: null-on-failure that falls through to a trusted source.

## Primary diagram

```
  The validation seam — one request, one guard, one downstream shape

  ┌─ header (bytes) ──────────────────────────────────┐
  │  x-bi-mcp-config: eyJ1cmwiOiJodHRwczovL2V4LmNvbSJ9  │
  └─────────────────────┬─────────────────────────────┘
                        │
  ┌─ decodeConfigHeader ▼─────────────────────────────┐
  │                                                    │
  │  1. base64 decode         (fail → catch → null)   │
  │     "eyJ1c…" → '{"url":"https://ex.com"}'          │
  │                                                    │
  │  2. JSON.parse            (fail → catch → null)   │
  │     '{"url":"https://ex.com"}' → { url: … }        │
  │                                                    │
  │  3. isMcpConfigOverride   (fail → return null)    │
  │     ┌─ typeof object                              │
  │     ├─ url: string or absent                      │
  │     ├─ authType: in VALID_AUTH_TYPES or absent    │
  │     └─ bearerToken: string or absent              │
  │                                                    │
  │  4. normalizeConfig                                │
  │     ┌─ trim url; empty → undefined                │
  │     └─ trim token; empty → undefined              │
  │                                                    │
  └─────────────────────┬─────────────────────────────┘
                        │
                        │  McpConfigOverride | null
                        ▼
  ┌─ downstream — sees narrowed type ─────────────────┐
  │  mcpUrl(override): override.url ?? env ?? default │
  │  buildAuthProvider(sid, override):                │
  │    type = override.authType ?? env.type            │
  │    (narrowed — no cast needed)                    │
  └───────────────────────────────────────────────────┘
```

## Elaborate

Where the pattern comes from: type guards as a TypeScript idiom are ~2016
(TS 2.0's user-defined type predicates). The broader "validate at the
boundary, narrow at the type level" pattern is decades older (SSL
handshakes, protobuf schema validation, JSON Schema validators).

The specific choice this repo makes — hand-written guard instead of a
schema library (zod, io-ts, valibot) — trades: no runtime dep + zero bytes
in the bundle + total control, against: no auto-derived error messages +
manual maintenance when the shape grows. For a three-field type, the
hand-written version wins on simplicity. For a large nested schema (say,
the full `Anomaly` type), a schema library is worth the dep.

Related patterns:

  → **Server-only trust.** Anything that flows in from a browser gets
    guarded server-side. Client-side validation is UX, not security.
  → **Fail closed.** On failure, fall to the more-trusted default (env),
    not the less-trusted one (skip validation and use raw input).
  → **Structural typing over nominal typing.** The guard doesn't check
    "is this literally a McpConfigOverride instance," it checks "does this
    have the shape a McpConfigOverride has." Right call for JSON-shaped
    inputs, where instances don't exist across the wire.

## Interview defense

**Q: Why not just cast the parsed JSON to `McpConfigOverride`?**

A: The cast is a lie. TypeScript's cast doesn't check anything at runtime
— it just tells the compiler "trust me." The parsed JSON might have
`authType: "hacked"` or `bearerToken: 42`. The cast puts that adversarial
value into `buildAuthProvider`, which passes it to `makeAuthProvider`'s
switch statement, which has no default case — the return would be
`undefined`. The bug shows up much later as "SDK crash: authProvider is
undefined." The guard forces the check to fire at the boundary, where the
error message can be "we discarded a malformed config" instead of a
mysterious null-pointer downstream.

Anchor: `lib/mcp/config.ts:50-60` (the guard) and
`lib/mcp/auth-providers/index.ts:57-75` (the switch with no default).

**Q: Why return null on every failure instead of throwing?**

A: The null-return is the fail-safe. A throw would crash the request.
Falling through to env config is the correct behavior for "we didn't
understand what the client sent" — it's neither a security violation to
ignore malformed input, nor a UX bug to have the app keep working. The
alternative (throw + 400) would surface as a broken page for the visitor,
even though the fix (delete localStorage or hit "reset to defaults") is
one click away. Null-and-fall-through means the app degrades gracefully.

Anchor: `lib/mcp/config.ts:87-100` — every failure path lands on `return
null`.

**Q: Why is the enum check in a Set instead of a switch or an array?**

A: Set gets O(1) membership, which matters less at 3 elements and more at
30. What actually matters: the Set is typed as `Set<McpAuthType>`, so if
someone adds a fourth enum value to `McpAuthType`, TypeScript flags the
Set literal as missing that value. It's a compile-time check that runtime
enforcement stays in sync with the type. An array with `.includes()`
would work but doesn't carry the same tight coupling.

Anchor: `lib/mcp/config.ts:41-45`.

## See also

- `03-user-chosen-mcp-url-boundary.md` — the trust boundary this guard sits on
- `05-model-output-validation.md` — the same shape, applied to LLM output
- `02-oauth-pkce-dcr-boundary.md` — where a validated override lands
