# 04 — Transactions and integrity

**Invariant enforcement · Case B (no DB) · type guards + write shape as constraints**

## Zoom out — where this concept lives

In a database, integrity comes from three places: constraints declared in the schema (FKs, `NOT NULL`, `CHECK`), transactions that make multi-row writes atomic, and unique indexes that catch dup keys. When you don't have a schema, those three enforcers scatter into different code layers — and if you don't put them anywhere, integrity is enforced only by *hope*.

```
  Zoom out — where integrity lives in this repo

  ┌─ Client (browser) ─────────────────────────────────────┐
  │  UI validation (McpConfigModal.tsx)                    │
  │    ↓ trims empty strings, disables save on bad state   │
  │  wire encoding: btoa(JSON.stringify(config))           │
  └────────────────────────┬────────────────────────────────┘
                           │  x-bi-mcp-config header
  ┌─ Service ──────────────▼────────────────────────────────┐
  │  ★ THIS FILE ★ — where are invariants enforced, and    │
  │  where does a bad write silently break something?      │
  │                                                          │
  │  decodeConfigHeader → isMcpConfigOverride (type guard)  │
  │    ↑ THE strongest integrity path in the repo           │
  │                                                          │
  │  putInsights → clear() + set() (atomic replace)         │
  │    ↑ transaction-substitute via write shape             │
  │                                                          │
  │  withAuthCookies → AsyncLocalStorage-scoped store       │
  │    ↑ per-request isolation; concurrent-safe             │
  │                                                          │
  │  cookie encryption: AES-256-GCM under AUTH_SECRET       │
  │    ↑ integrity + confidentiality on the wire            │
  └──────────────────────────────────────────────────────────┘
```

The question: **for every invariant in this app, name who enforces it — the type system, a runtime guard, the write shape, or nobody.**

## The structure pass — layers, one axis, seams

Hold one axis: **who enforces this invariant?** Trace it across the layers and watch the answer flip.

```
  Axis: "who enforces this invariant?"

  ┌── UI layer ────────────────────────────────────────┐
  │  invariant: user can't save 'bearer' with no token │
  │  enforcer:  UI disables save button                 │
  │             (McpConfigModal.tsx:52)                 │
  └─────────────────┬───────────────────────────────────┘
                    │  seam: the wire (can be bypassed
                    │        by curl / crafted header)
                    ▼
  ┌── Wire boundary ───────────────────────────────────┐
  │  invariant: header decodes to a valid override      │
  │  enforcer:  isMcpConfigOverride() type guard        │
  │             (lib/mcp/config.ts:50-60)               │
  │             ← the trust boundary                    │
  └─────────────────┬───────────────────────────────────┘
                    │  seam: env fallback if invalid
                    ▼
  ┌── Provider factory ────────────────────────────────┐
  │  invariant: 'bearer' has a bearerToken;             │
  │             'oauth-bloomreach' has sessionId +      │
  │             redirectUri                             │
  │  enforcer:  makeAuthProvider throws on missing      │
  │             (lib/mcp/auth-providers/index.ts:56-76) │
  └─────────────────┬───────────────────────────────────┘
                    │  seam: within one session
                    ▼
  ┌── Storage layer ────────────────────────────────────┐
  │  invariant: bi_auth Store not tampered              │
  │  enforcer:  AES-256-GCM auth tag                    │
  │             (lib/mcp/auth.ts:62-79)                 │
  └─────────────────────────────────────────────────────┘
```

The answer flips at every seam. That's a **defense-in-depth** pattern — no single enforcer is trusted to do the whole job, because each has a different failure mode. The UI can be bypassed, the type guard can be fooled by a valid-but-nonsense config, the factory catches missing required fields, the crypto catches tampering. Each layer answers "who enforces this?" differently.

## How it works

### Move 1 — the mental model

You already know this from a React form: you disable the submit button when the form's invalid (UI-level), you validate on submit again (JS-level), and the server validates on receipt (server-level) before it hits the database — which validates once more against its schema constraints. Four enforcers, four different failure modes, one invariant.

This app follows the same pattern *without* the database layer, and the missing layer matters. The last-resort validator here is the **type guard**, not a foreign-key constraint. If the type guard doesn't cover a case, integrity leaks.

```
  The pattern — layered enforcers, each with its own failure mode

  layer          enforces                       what breaks if it's the only one
  ─────          ─────────                      ────────────────────────────────
  UI             UX ("bad = disabled button")   curl bypasses it
  type guard     shape ("valid JSON, valid      valid-but-wrong values slip through
                  discriminant")                 (e.g. bearerToken with authType='anonymous')
  factory        cross-field ("bearer needs a   caller has to catch the throw
                  token")
  runtime crypto tampering ("cookie unchanged   only guards the wire, not the write
                  since we signed it")
```

Skip any layer and the invariant becomes hope. This codebase has all four for MCP config; it has none of them (beyond types) for `Insight` shape, which is why file 05 will have a lot to say about schema evolution.

### Move 2 — the specific integrity mechanisms

#### Mechanism 1 — `isMcpConfigOverride`: the wire-boundary type guard

The single strongest integrity mechanism in the codebase. Every field is checked; anything unknown is rejected; empty strings normalized separately so a blank UI field doesn't clobber env.

Real code (`lib/mcp/config.ts:50-70`) side-by-side with annotation:

```typescript
export function isMcpConfigOverride(value: unknown): value is McpConfigOverride {
  if (value === null || typeof value !== 'object') return false;
              // ↑ null must be rejected explicitly — typeof null === 'object'
  const v = value as Record<string, unknown>;
  if (v.url !== undefined && typeof v.url !== 'string') return false;
                          // ↑ optional means "undefined OR right type"
  if (v.authType !== undefined) {
    if (typeof v.authType !== 'string') return false;
    if (!VALID_AUTH_TYPES.has(v.authType as McpAuthType)) return false;
                       // ↑ closed-set discriminant — reject unknown values
                       //   (this is the guard against future auth types being
                       //   assumed valid by an old server)
  }
  if (v.bearerToken !== undefined && typeof v.bearerToken !== 'string') return false;
  return true;
}
```

The type guard is called from three places:

  1. `readPersistedConfig()` — when reading `localStorage['bi:mcp_config']` on the client. A tampered localStorage value falls through to env defaults.
  2. `decodeConfigHeader()` — when the server decodes `x-bi-mcp-config` from an inbound request. A malformed header falls through to env defaults.
  3. Implicitly via `normalizeConfig()` — which callers use after the guard passes.

That last one is subtle and important. `normalizeConfig` strips empty strings *after* validation, so the invariant "`bearerToken` is present and non-empty" is a *two-step* enforcement: the guard says "if present, is a string," and `normalizeConfig` says "if empty, treat as absent."

```
  Two-step wire validation — annotated

  step 1: shape check                        step 2: presence check
  ────────────────                           ────────────────
  isMcpConfigOverride(v)                     normalizeConfig(v):
    · v is an object                           if v.url is '  '
    · v.url is string or undefined                → v.url = undefined
    · v.authType is one of {oauth-bloomreach,   if v.bearerToken is ''
                             bearer, anonymous}     → v.bearerToken = undefined
    · v.bearerToken is string or undefined

  neither step alone enforces the invariant. Together they do.
```

Why the two steps? Because "the guard rejects empty strings" would fail the wrong way — a UI form with a blank field would submit a partial config, get rejected entirely, and fall back to env when the user meant "leave URL default, use bearer with THIS token." The two-step design lets *partial overrides* work: the guard passes anything shaped right, `normalizeConfig` strips empty-string fields so they don't override env, and `connect.ts:mcpUrl()` reads either `override.url ?? process.env.MCP_URL ?? …` (`lib/mcp/connect.ts:38-48`).

**All four failure modes are covered:**
  → missing header → `decodeConfigHeader` returns `null`, connect uses env.
  → malformed base64 → `atob` throws inside the `try`, returns `null`.
  → invalid JSON → `JSON.parse` throws, returns `null`.
  → invalid shape → `isMcpConfigOverride` returns `false`, returns `null`.

There's a full test file at `test/mcp/config.test.ts` walking each failure mode.

#### Mechanism 2 — `makeAuthProvider`: cross-field enforcement

The type guard says "the shape is valid." It does *not* say "if `type` is `bearer`, `bearerToken` must be present." That's a cross-field invariant, and it's enforced one layer down.

Real code (`lib/mcp/auth-providers/index.ts:56-76`):

```typescript
export function makeAuthProvider(config: McpAuthConfig): OAuthClientProvider {
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

This is a **discriminated-union constraint** — the DB analog is a `CHECK` constraint that says `CHECK (type = 'bearer' → bearer_token IS NOT NULL)`. TypeScript can't express that constraint at the type level (or at least, not cleanly), so the check moves to runtime, at the factory boundary. Anything that reaches `makeAuthProvider` with a bad shape throws immediately; the error propagates up through `connect.ts`, which the route handler catches and turns into a 400.

Why not enforce at the type level with a discriminated union? Because the shape comes off the wire — from `localStorage` on the client, from a header on the server — and until you've validated at runtime, the TS type is a lie. The factory's throw is the *first* place the invariant is safe to trust.

#### Mechanism 3 — `putInsights`: the write-shape "transaction"

Where: `lib/state/insights.ts:57-71`.

```typescript
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  const s = sessionState(sessionId);
  s.insights.clear();      // ← both maps cleared
  s.anomalies.clear();     //   before either set — atomic from the
                           //   perspective of any concurrent reader
                           //   because JavaScript is single-threaded
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

**The invariant:** for every `Insight` in the map, if it has an anomaly counterpart, the anomaly's key is the same as the insight's ID. And: an anomaly never exists without its parallel insight.

**The enforcer:** the write shape. Both maps are cleared before either is set, so there's no window in which insights are old but anomalies are new. Because JavaScript is single-threaded per instance, no concurrent reader can observe an intermediate state — the clear-and-rebuild is effectively atomic.

This works *because* the language is single-threaded. If this were Go with goroutines, you'd need a mutex around the whole block, or the reader could catch you mid-clear. The comment on the file (`lib/state/insights.ts:5-8`) names the concurrent-user concern but doesn't need to name the atomicity concern — the language enforces it.

```
  The DB analog — put-and-clear as an atomic replace

    SQL analog:                                Node/TS reality:
    ─────────────                              ────────────────
    BEGIN;                                     s.insights.clear()
      DELETE FROM insights WHERE session = ?;  s.anomalies.clear()
      DELETE FROM anomalies WHERE session = ?; items.forEach(...)
      INSERT INTO insights ...;                (all in one synchronous
      INSERT INTO anomalies ...;                turn of the event loop)
    COMMIT;

    both give: "readers see either the old feed or the new feed,
                never a half-cleared, half-inserted state"
```

Verdict: **the write shape is a transaction substitute, and it works because of the single-threaded runtime.** File 05 discusses what breaks the moment we introduce async between the clears and the sets.

#### Mechanism 4 — `withAuthCookies`: per-request scoping via AsyncLocalStorage

Where: `lib/mcp/auth.ts:86-104`.

The problem it solves: **Next's cookie API has a request-vs-response split** — reading a cookie *after* setting it in the same request returns the OLD value. The OAuth provider's implementation calls `saveClientInformation`, then later reads it back to sign a request; if that read hit the cookie API directly it would return stale.

The solution: wrap the whole request in an `AsyncLocalStorage` context, seed a mutable `Store` from the cookie once at the start, let the provider read/write against that store, and flush back to the cookie once at the end.

```
  Per-request auth store — AsyncLocalStorage as a request-scoped transaction

  ┌── request arrives ────────────────────────────────────┐
  │                                                        │
  │  withAuthCookies(async () => {                        │
  │    ctx = { store: decrypt(cookie), dirty: false }      │  ← START
  │    requestStore.run(ctx, fn)                           │
  │      fn calls provider.saveClientInformation(...)      │
  │      → writeAll(store) sets ctx.store, ctx.dirty=true  │
  │      fn calls provider.tokens()                        │
  │      → readAll() returns ctx.store (not cookie!)       │
  │                                                        │
  │    if (ctx.dirty) cookies().set(bi_auth, encrypt(...)) │  ← END
  │  })                                                    │
  └────────────────────────────────────────────────────────┘

  invariant: within one request, all reads see writes from
             earlier in the same request. Between requests,
             the cookie is the atomic checkpoint.
```

That's a **request-scoped transaction** — the analog of `BEGIN`/`COMMIT` for cookie state, with the cookie itself as the durable checkpoint. Two concurrent requests on the same instance each get their own `ctx`, so they can't step on each other; two requests on different instances see the same cookie, so state survives the instance boundary.

Verdict: **strongest concurrency-safety mechanism in the repo, and correctly reasoned about.** The comment on `lib/mcp/auth.ts:41-45` names the mechanism: *"Each request gets its own ALS context, so concurrent requests on one instance never share state."*

#### Mechanism 5 — AES-256-GCM auth tag: wire integrity

Where: `lib/mcp/auth.ts:62-79`.

The bi_auth cookie is encrypted with AES-256-GCM. GCM is an *authenticated* encryption mode — the auth tag detects any tampering. `decryptStore` catches the failure silently (`catch { return {}; }` on line 76-78) and returns an empty store, which is treated as "not authenticated." The comment names this: *"tampered, rotated-secret, or corrupt cookie → treat as no auth."*

That's the right failure mode: **when integrity fails, deny access.** The alternative — throwing 500 on a bad cookie — would be worse UX and no more secure.

Verdict: **canonical AEAD usage.** The one thing to note: `AUTH_SECRET` rotation is a full session-invalidation event by design (everyone's cookies fail decrypt, everyone re-authenticates). That's a deliberate tradeoff, spelled out in the comment.

### Move 3 — the principle

The principle: **when there's no DB, invariants have to be enforced by the code — and the honest way to do it is at *every* layer where the invariant could be violated.** The MCP config path is the model to imitate:

  → UI-level: disable the bad state.
  → Wire-level: type-guard the incoming payload.
  → Factory-level: enforce cross-field invariants that types can't express.
  → Storage-level: crypto for tampering, atomicity for concurrency.

Each layer's failure mode is different, so no single layer is trusted with the whole invariant. That's *defense in depth* — the DB rule that constraints belong close to the storage engine becomes, in a no-DB app, "constraints belong close to *every* boundary the data crosses."

## Primary diagram — the layered enforcer stack

```
  Every invariant in this repo, and where it's enforced

  ─────────────────────────────────────────────────────────────────────────
  invariant                          enforcer(s)                    verdict
  ─────────────────────────────────────────────────────────────────────────

  MCP config: shape is valid          isMcpConfigOverride guard      strong
    (URL/authType/bearerToken)          (lib/mcp/config.ts:50-60)      ✓

  MCP config: 'bearer' has token      makeAuthProvider throw         strong
    'oauth' has sess+redirect          (auth-providers/index.ts:56-76) ✓

  MCP config: no drift from env       normalizeConfig empty-strip    strong
    on blank fields                    (lib/mcp/config.ts:63-70)       ✓

  Insight.id ↔ Anomaly.id             putInsights clear+set (atomic) OK,
    stay coherent                      (lib/state/insights.ts:57-71)  language-
                                                                       enforced

  bi_auth cookie: not tampered        AES-256-GCM auth tag          strong
                                       (lib/mcp/auth.ts:62-79)         ✓

  Auth store: request-scoped reads    withAuthCookies + ALS          strong
    see writes from earlier in         (lib/mcp/auth.ts:86-104)        ✓
    same request

  Investigation.diagnosis shape       ← NOBODY                       weak
    matches Diagnosis interface        (two declarations,
                                         no enforcement)                ✗

  Insight schemaVersion consistent    ← NOBODY                       weak
    across tier-5 committed JSONs      (see file 05)                    ✗

  Round-trip Insight → Anomaly →      test (test/state/               OK
    Insight preserves core fields      insights.test.ts)               (documented
                                                                        loss)
  ─────────────────────────────────────────────────────────────────────────

  Legend:
    ✓  layered enforcement present, well-tested
    ✗  no enforcement; drift can happen silently
```

The two ✗ rows are file 07's audit findings. Both are latent bugs — nothing enforces them today, and the shapes will drift the moment someone edits one side without the other.

## Elaborate

Where the pattern comes from: this is the layered-validation discipline from *Growing Object-Oriented Software, Guided by Tests* (Freeman & Pryce) applied at the persistence boundary. The heuristic they name: *"validate at every seam a hostile input could cross."* In an app with a DB, the DB catches the last violation. In an app without one, *every* seam is the last one — and each has to catch what only it can catch.

The AES-GCM + AsyncLocalStorage combo (mechanism 4 + 5) is worth a separate note: it's the *cleanest* pattern I've seen for "serverless-friendly server-side session state." The cookie is the atomic checkpoint across instances; the ALS context is the atomic checkpoint within a request; the crypto is the tamper detector. Three atomicities, three scales, one mechanism. If you added a real DB tomorrow, you'd move `SessionAuthState` into it — but you'd keep this pattern for the *request-scoped* state, because "one canonical cookie per session, decrypted into a request context" is genuinely a good idea regardless of the underlying store.

Related reading: PoEAA's *Unit of Work* pattern — `withAuthCookies` is a hand-rolled Unit of Work, tracking `dirty` and flushing at the end. `ctx.dirty` is the check; `cookies().set(...)` is the flush. That's the whole pattern in ~15 lines.

## Interview defense

### Q1 — "you have no database. How do you enforce invariants?"

> Four layers, each catching what only it can catch. Let me walk them for one representative invariant — "if MCP config's authType is 'bearer', it must have a bearerToken":

```
  layer          enforces                          failure mode covered
  ─────          ─────────                         ────────────────────
  UI             disable save when bearer + no    "the user clicked save"
                 token
  type guard     shape valid: authType is in the  "someone crafted a header
                 closed set                        with authType='malformed'"
  factory        cross-field: bearer needs token  "valid shape but missing
                                                    the token for that type"
  storage        cookie has AEAD tag              "someone tampered with
                                                    the cookie in transit"
```

> No single layer is the "real" enforcer. The type guard catches shape but not cross-field. The factory catches cross-field but only after the guard passes. The crypto catches tampering but not shape. Skip any layer and you get a specific class of hole. Defense in depth is the whole shape.

Anchor: "four layers, four failure modes."

### Q2 — "your `putInsights` clears both maps then sets both. That's not atomic in a real sense — what happens under concurrency?"

> In a real sense, it *is* atomic — because the runtime is single-threaded. Node runs one turn of the event loop at a time, and `putInsights` is a synchronous function. There's no way for a concurrent reader to observe the state between `clear()` and the final `.set()`. Any incoming request that hits `getInsight` either arrived before `putInsights` started (sees old state) or after it finished (sees new state).
>
> Two things would break this. First, if I introduced an `await` between the clears and the sets, another request could interleave and see cleared state. Second, if I moved to Deno with `--parallel` or a worker thread that shares the `Map`, I'd need a real mutex. Neither applies today.
>
> The DB analog is a `BEGIN; DELETE ... ; INSERT ... ; COMMIT;` block. Same guarantee — readers see the old snapshot or the new one, never the middle.

```
  the atomicity comes from the runtime, not the code

  putInsights runs synchronously → the event loop can't interleave
  → concurrent requests see either OLD or NEW, never MIXED
  → single-threaded JavaScript = poor man's serializable isolation
```

Anchor: "sync JS + no `await` between the writes = serializable-ish for free."

### Q3 — "what's the biggest integrity gap in this codebase?"

> `Investigation.diagnosis` versus `Diagnosis`. Same conceptual entity, two different shapes declared in the same file, `hypothesesConsidered` typed differently in each. Nothing enforces they stay in sync. The moment someone edits `Diagnosis` to add or rename a field, the shape embedded in `Investigation` drifts, and any code that reads one thinking it's the other will panic at runtime.
>
> The fix is a one-line change: `Investigation.diagnosis: Diagnosis` instead of the inline object type. Reuse the canonical shape, single source of truth, TypeScript enforces the invariant thereafter.
>
> That's the pattern I'd generalize: **if you find yourself writing the same object type twice in the same file, that's the DB analog of storing the same fact in two columns.** One declaration site per fact.

Anchor: "same shape, two declaration sites, no enforcement — file 07 marks this red flag."

## See also

- `01-the-data-model-and-its-shape.md` — the entities whose invariants this file walks.
- `02-normalization-and-duplication.md` — why write-atomicity is the DB-transaction substitute here.
- `05-migrations-and-evolution.md` — what the invariant "old shapes still validate" costs.
- `07-data-modeling-red-flags-audit.md` — the `Diagnosis` drift and the missing `schemaVersion` are marked here.
