# blooming insights — synthetic-first + swappable-MCP plan

> Target: **fully-synthetic default UX + hidden demo + swappable MCP surface**.
> Frozen-core preserved (agents, AgentEvent contract, UI shape, tier-2 eval
> harness). This is a **fifth use of the DataSource seam** — not a rewrite.
>
> Shipping window: ~1 day for phases 1+2, ~2-3 days for phases 3+4.
> Grounded against `main` at `d4c4a8d` (rehearse regen complete).

---

## 0. Motivation

Three things to fix, one thing to make stronger:

**Fix 1: `demo` as the default UX is misleading.** Landing on the app right
now shows a cached snapshot. A visitor who wants to see the actual agent work
has to know to change modes. The product IS the live reasoning trace — burying
it behind a mode toggle undersells the whole system.

**Fix 2: `live-bloomreach` is baked in.** OAuth 2.1 + PKCE + DCR is
Bloomreach-shaped. `BloomreachDataSource` conflates two concerns: (a) generic
HTTPS MCP client discipline (transport, retry ladder, TTL cache, spacing gate,
30s per-call timeout) and (b) Bloomreach-specific auth + tool namespace.
Cannot point the same code at a different MCP server without ripping open the
auth flow.

**Fix 3: `demo` UI entry point creates confusion.** Three modes is one too
many for a fresh visitor. Two clear modes + a hidden-but-functional demo mode
(preserved as reliability path, dev tool, and regression evidence) is the
cleaner shape.

**Make stronger: the DataSource seam receipt.** The seam has now shipped in 4
uses (Olist add → Olist remove → Synthetic add → FaultInjecting decorator).
This work adds a **5th use** (generic MCP over any transport + any auth) with
zero caller-surface change. That's the tier-2 story getting louder, not weaker.

---

## 1. Current state (verified on `main`)

```
UI mode toggle          app/page.tsx:170-172   3 options: demo · live-bloomreach · live-synthetic
Default mode            app/page.tsx:62        useState<BriefingMode>('demo')
Migration               app/page.tsx:73-78     legacy 'live'/'live-sql' → 'live-bloomreach'
                                                unknown/null → 'demo'
Backend factory         lib/data-source/index.ts:53   parseLiveMode default = 'live-bloomreach'
Bloomreach coupling     lib/mcp/auth.ts:160    BloomreachAuthProvider (OAuth PKCE DCR)
                        lib/mcp/connect.ts     connectMcp orchestrates Bloomreach flow
                        lib/data-source/bloomreach-data-source.ts   HTTPS client + retry + cache

Frozen-core surfaces already established
──────────────────────────────────────────
DataSource port         lib/data-source/types.ts (71 LOC interface)
Adapters today          BloomreachDataSource · SyntheticDataSource · FaultInjectingDataSource
AptKit bridge           lib/agents/aptkit-adapters.ts (263 LOC, 3 classes)
Frozen agents           MonitoringAgent · DiagnosticAgent · QueryAgent · RecommendationAgent
Test suite              24 files / 221 passing
Eval baseline           eval/baseline.json (measured against SyntheticDataSource)
```

---

## 2. Design

Three-layer architecture — one new abstraction, two rename operations, one env
config surface.

```
                              ┌───────────────────────────────┐
                              │  DataSource port              │
                              │  (unchanged 71 LOC interface) │
                              └───────────────┬───────────────┘
                                              │
        ┌─────────────────────────────────────┼─────────────────────────────────────┐
        │                                     │                                     │
        ▼                                     ▼                                     ▼
┌──────────────────┐             ┌────────────────────────┐             ┌──────────────────────┐
│ Synthetic        │             │ McpDataSource (new)     │             │ FaultInjecting        │
│ DataSource       │             │  · HTTPS transport      │             │ DataSource            │
│ (default UX)     │             │  · TTL cache            │             │ (offline decorator)   │
│ (unchanged)      │             │  · Retry ladder         │             │ (unchanged)           │
└──────────────────┘             │  · Spacing gate         │             └──────────────────────┘
                                 │  · Injectable AuthProv  │
                                 └────────┬────────────────┘
                                          │
                          ┌───────────────┼──────────────────────┐
                          ▼               ▼                      ▼
                 ┌─────────────────┐ ┌──────────────┐ ┌────────────────────┐
                 │ Bloomreach      │ │ Bearer       │ │ Anonymous          │
                 │ AuthProvider    │ │ AuthProvider │ │ AuthProvider       │
                 │ (OAuth PKCE DCR)│ │ (token in    │ │ (no auth for local │
                 │ (extracted)     │ │ Auth header) │ │ dev MCP servers)   │
                 └─────────────────┘ └──────────────┘ └────────────────────┘
```

**Modes after (visible to user):**

```
live-synthetic          default; in-process; no creds; deterministic
live-mcp                env-configured MCP server; any auth; renamed from live-bloomreach
demo                    HIDDEN from UI selector; reachable via ?mode=demo or ?demo=cached
                        (kept because: reliability path when live-mcp times out;
                         regression evidence; dev tool; graceful degradation surface)
```

---

## 3. Phases

### Phase 1 — Hide demo from the UI selector (~15 min)

**What:**
- Remove the `{ value: 'demo', label: 'demo' }` option from `app/page.tsx:170`
- Keep all backend demo mode handling (`useBriefingStream`'s `isDemo` branch,
  `?demo=cached` URL param, committed snapshots in `public/demo/*`,
  `investigations.ts` demo tier)
- Add code comment naming the hidden entry points (`?demo=cached`,
  `localStorage.setItem('bi:mode', 'demo')` for dev override)

**What NOT to do:**
- Do not delete any code
- Do not delete any snapshots
- Do not remove the `'demo'` value from the `BriefingMode` type

**Frozen-core check:**
- DataSource seam untouched
- AgentEvent contract untouched
- Route handlers untouched
- Tests untouched (integration tests may reference `mode: 'demo'`; leave)

**Files changed:** `app/page.tsx` only. ~10 lines removed, ~5 lines added
(migration + comment).

---

### Phase 2 — Default to `live-synthetic` (~15 min)

**What:**
- `app/page.tsx:62` — `useState<BriefingMode>('demo')` → `useState<BriefingMode>('live-synthetic')`
- `app/page.tsx:70` — the SSR-detection branch (`typeof window === 'undefined'`)
  → sets `'live-synthetic'`
- `app/page.tsx:78` — comment "any other value (or null) → default `'demo'`
  stays" → "any other value → default `'live-synthetic'`"
- `lib/data-source/index.ts:53` — `parseLiveMode` unknown → `'live-bloomreach'`
  becomes unknown → `'live-synthetic'`
- README's `bi:mode` line (line ~120) → note new default

**Migration for existing users:**
- localStorage may still carry `'demo'` from prior visits. The existing
  migration block reads all saved values; add a note that `'demo'` remains
  respected if explicitly saved (dev override still works). New visitors and
  cleared-cache visitors land on `live-synthetic`.

**Frozen-core check:**
- Same as Phase 1

**Files changed:** `app/page.tsx`, `lib/data-source/index.ts`, `README.md`. ~15 lines.

---

### Phase 3 — Extract `McpDataSource` + `AuthProvider` abstraction (~2-4 hours)

The load-bearing phase. This is where the reusable seam gets its 5th use.

**New files:**

- `lib/data-source/mcp-data-source.ts` (~200 LOC) — the generic MCP client.
  Copies the HTTPS transport + retry ladder + TTL cache + spacing gate + 30s
  per-call timeout logic out of `bloomreach-data-source.ts`. Accepts an
  `AuthProvider` (MCP SDK's `OAuthClientProvider` interface) as constructor
  arg. All Bloomreach-specific behavior removed.

- `lib/mcp/auth-providers/bloomreach.ts` — the existing `BloomreachAuthProvider`
  moved here. Zero behavior change; only relocation + explicit interface.

- `lib/mcp/auth-providers/bearer.ts` (~50 LOC) — implements `OAuthClientProvider`
  interface but backs it with a static bearer token from env. The MCP SDK's
  transport reads tokens from the provider; a bearer-only implementation
  returns the same token forever and never triggers a full OAuth flow.

- `lib/mcp/auth-providers/anonymous.ts` (~30 LOC) — a no-auth provider for
  local MCP servers (dev tools). Returns undefined tokens; the transport sends
  no Authorization header.

- `lib/mcp/auth-providers/index.ts` — factory that picks the provider from
  env (`MCP_AUTH_TYPE`). Defaults to `bloomreach-oauth` for backward
  compatibility.

**Changed files:**

- `lib/data-source/bloomreach-data-source.ts` becomes a **preset**: exports
  a `new McpDataSource({ auth: new BloomreachAuthProvider(...), ... })`
  factory function. The class itself either goes away (if all call sites move
  to the factory) or becomes a thin subclass. Prefer the factory route — less
  code.

- `lib/mcp/connect.ts` — takes an `authProvider` arg (or reads it from env)
  instead of hardcoding Bloomreach's OAuth. Return shape unchanged.

- `lib/data-source/index.ts` — `makeDataSource` factory reads env to decide
  which auth to inject into `McpDataSource` for the `live-mcp` branch (renamed
  from `live-bloomreach`).

**Frozen-core check:**
- DataSource port interface — **unchanged**
- Agents — **unchanged** (they hold `DataSource`, not `BloomreachDataSource`)
- AgentEvent contract — **unchanged**
- UI streaming shape — **unchanged**
- Eval harness — **unchanged** (uses SyntheticDataSource directly)
- Tests — **may need update**: `test/mcp/client.test.ts` and `test/mcp/auth.test.ts`
  reference internal Bloomreach names; check + adjust imports only, keep
  behavior tests the same

**Verification:**
- All 221 tests still pass
- Eval baseline unchanged (didn't use BloomreachDataSource)
- Manual: local dev with a fake MCP server pointed at via `MCP_URL` — the
  agents run against it without Bloomreach knowing

---

### Phase 4 — Env config surface + mode rename (~30 min)

Backend surface for the swappable-MCP capability. UI comes in Phase 5.

**What:**
- Rename mode: `live-bloomreach` → `live-mcp` (visible label: `live · mcp`)
- localStorage migration: `'live-bloomreach'` → `'live-mcp'` (add to existing
  migration block that already handles `'live-sql'` and `'live'`)
- Env vars documented in README:
  ```
  MCP_URL                the MCP server URL (defaults to Bloomreach if unset,
                          giving a working example config out of the box)
  MCP_AUTH_TYPE          oauth-bloomreach | bearer | anonymous
                          (default: oauth-bloomreach)
  MCP_AUTH_TOKEN         used only when MCP_AUTH_TYPE=bearer
  ```
- `.env.example` file created with the new vars documented (currently no
  such file per DEPLOY.md)

**Backward compat:**
- `MCP_URL` unset + `MCP_AUTH_TYPE` unset → behaves identically to today's
  `live-bloomreach` (Bloomreach is the **default example config**, so
  new visitors see a working live-mcp mode out of the box)
- localStorage `'live-bloomreach'` still works (migration handles rename)
- No live users to migrate — greenlit for aggressive rename

**Files changed:** `app/page.tsx`, `README.md`, new `.env.example`. ~30 lines.

---

### Phase 5 — UI settings for MCP config (~1-2 hours)

Enables a portfolio visitor to plug in their own MCP server without deploying,
editing env, or forking. This is where the **swappable** claim earns its keep.

**What:**

Add a small settings modal (or expandable drawer) near the mode toggle in
`app/page.tsx`. Fields:

```
MCP URL                text input; defaults to `MCP_URL` env
Auth type              dropdown: anonymous | bearer | oauth-bloomreach
                        defaults to `MCP_AUTH_TYPE` env
                        (default default: oauth-bloomreach)
Bearer token           text input, shown only when auth type = bearer
                        (with "test only, not for production credentials"
                         warning)
[Save]  [Reset to defaults]
```

**Persistence:**

```
localStorage['bi:mcp_config']    JSON: { url, authType, bearerToken? }
                                 If set, overrides env; if unset, uses env
```

**Adapter integration:**

The route handler receives the config as part of the request, not by reading
localStorage directly (server has no localStorage access). Practical shape:

- Client stores `bi:mcp_config` in localStorage
- Client sends it as a header on the streaming fetch. Bearer token is
  encrypted server-side into a short-lived cookie (same AES-256-GCM
  discipline as `bi_auth`) so it doesn't ride in every subsequent request
  plaintext
- Route reads header + cookie, falls back to env, constructs `McpDataSource`
  with the right auth provider

**Auth strategy — per-flow specifics:**

- **anonymous** — no additional fields; `AnonymousAuthProvider` sends no
  Authorization header. For local dev MCP servers.
- **bearer** — token input required; `BearerAuthProvider` sends
  `Authorization: Bearer <token>` on every call. Token stored in localStorage
  with a UI warning box: *"Bearer tokens in localStorage are less secure than
  the encrypted session cookie. Use test tokens only."*
- **oauth-bloomreach** — no additional user input. Save triggers the OAuth
  flow immediately (redirect to authorize endpoint of the entered URL, PKCE
  challenge, DCR if the server supports it, callback to
  `/api/mcp/callback`). The `bi_auth` cookie handles token storage exactly
  as it does today; only the endpoint URLs change. The flow generalizes
  cleanly because the mechanics don't depend on which server — only which
  endpoints.

**Security notes to document in the UI:**

```
⚠ Only enter MCP server URLs you trust.
  The MCP server sees every tool call the agent makes on your behalf.

⚠ Bearer tokens in localStorage are less secure than the encrypted
  session cookie. Use test tokens; do not paste production credentials.

✓ OAuth tokens (Bloomreach and other OAuth 2.1 servers) are stored in an
  AES-256-GCM encrypted, HttpOnly, SameSite=None cookie — the same bi_auth
  mechanism already used today.
```

**Files changed:**

```
app/page.tsx                            + settings modal + open button
components/settings/McpConfigModal.tsx  new
lib/mcp/config.ts                       new; JSON validator + normalizer;
                                         reads header/cookie/env in order
app/api/mcp/callback/route.ts           unchanged (URL comes from session)
README.md                               UI settings docs
```

**Frozen-core check:**

- UI: adds a modal; existing streaming shape unchanged
- Auth mechanics: existing OAuth flow generalizes cleanly (only URLs change);
  new bearer/anonymous providers are pure additions
- DataSource seam: unchanged; adapter picks auth from config
- Tests: add one integration test for config read/write; existing 221 pass

---

## 4. What breaks (and how)

**Backward-compat clearance: confirmed no live `live-bloomreach` users
against real Bloomreach today** — greenlit for aggressive rename in Phase 4.
Only migration concern is stale localStorage values from prior visits, which
the existing migration block already handles.

**Nothing user-visible if all five phases ship together.** Phase-by-phase
shipping has intermediate states:

| Ship phase | Intermediate state | Broken? |
|------------|---------------------|---------|
| 1 only     | demo hidden but default; user has to click | UX gets worse (demo hidden but still default) |
| 1 + 2      | live-synthetic default; demo hidden; Bloomreach still baked in | No breakage; UX improved |
| 1 + 2 + 3  | McpDataSource extracted; Bloomreach = preset factory | No breakage; internal only |
| 1 + 2 + 3 + 4 | env config surface + mode renamed to `live-mcp` | No breakage; deploy-time flexibility |
| 1 + 2 + 3 + 4 + 5 | UI settings modal — per-browser MCP config | No breakage; portfolio-visitor capability |

**Ship 1+2 first as a coherent UX unit** (~30 min total). Then 3 as a
separate PR (~2-4 hr load-bearing refactor). Then 4 as small wiring (~30 min).
Then 5 as the frontend capability (~1-2 hr).

---

## 5. Documentation impact

Documents that reference `live-bloomreach` and need updates in phase 4:

- `README.md` (line ~120) — bi:mode enum values
- `docs/portfolio-hardening/blooming-insights-production-grade-plan.md` — mentions live-bloomreach in Section 1
- `.aipe/study-system-design/` — 12 files reference the seam
- `.aipe/study-agent-architecture/` — mentions bi:mode across sub-sections
- `.aipe/rehearse-*` — 4 books reference the mode

The `.aipe/*` docs were regenerated today (`8a058d6` + `d4c4a8d`); those are
short-lived and will be regenerated next `/aipe:study` + `/aipe:rehearse` runs
anyway. Do NOT touch them in this PR — let the regen catch them.

The `docs/portfolio-hardening/*` plan docs are longer-lived; update inline
during Phase 4.

---

## 6. Frozen-core discipline check

The tier-2 hardening plan named the frozen core as:
> "the AptKit adapter bridge (3 classes in `aptkit-adapters.ts`), the 4 active
> agents (thin wrappers), the `AgentEvent` contract, the UI, and the demo
> replay path."

This work touches:
- **UI**: yes — hiding the demo toggle option is a UI change. Scope is minimal
  (one dropdown item removed) and reversible (dev can override via URL
  param). Acceptable within "eval-driven prompt fix" spirit — but call it out
  explicitly as an intentional exception.
- **Demo replay path**: **preserved**. The whole point of Phase 1 is to hide
  the entry point, not remove the mechanism. `?demo=cached` still works,
  `bi:mode='demo'` still works if manually set in localStorage, all snapshots
  still commit, all backend branches still fire.
- **Agents, AgentEvent contract, adapter bridge**: **untouched**.
- **DataSource seam**: **5th use added, port interface unchanged.** The seam
  receipt gets stronger, not weaker.

---

## 7. Interview narrative impact

The rehearse books just regenerated frame the DataSource seam as having
"survived 4 uses without a caller-surface change." Post this work:

> "Five uses now. The 5th is the generalization itself — the `McpDataSource`
> class that lets any MCP server plug in, with `BloomreachDataSource`
> reduced to a preset factory. The seam earned its keep, then earned its
> keep again by being generalizable without breaking the abstractions
> already built on top of it."

That's a stronger receipt. The rehearse books will pick this up on the next
regeneration; no manual edit needed.

---

## 8. Sequencing recommendation

```
Session A     Phase 1 + 2 (hide demo, live-synthetic default)
              ~30 min · zero risk · immediate UX improvement
              Ship as one PR + commit

Session B     Phase 3 (McpDataSource + AuthProvider abstraction)
              ~2-4 hours · load-bearing refactor · needs eval + test check
              Ship as separate PR; run 221 tests + one eval run against
              Bloomreach preset to confirm behavior identical

Session C     Phase 4 (env config + mode rename to live-mcp)
              ~30 min · wiring + docs
              Ship as separate PR; deploy-time flexibility

Session D     Phase 5 (UI settings modal for MCP config)
              ~1-2 hours · frontend + one integration test
              Ship as separate PR; the "swappable" claim earns its keep here

Optional     Regenerate .aipe/study-* + .aipe/rehearse-* to pick up the
              new naming, the "5 uses of the seam" receipt, and the
              "portfolio visitor can plug in their own MCP" narrative.
```

Total estimate: **~1 day of work** across four sessions.

---

## 9. What this plan does NOT do

- Does not touch the eval harness, budget tracker, fault injector, or CI
  workflow (all Weeks 2-4 hardening remains stable)
- Does not delete the `demo` value from the `BriefingMode` type
- Does not delete any code from `useBriefingStream`, `useDemoCapture`,
  `investigations.ts`, or the `?demo=cached` URL handling
- Does not delete `BloomreachAuthProvider` or the OAuth PKCE DCR flow (moved,
  not removed)
- Does not remove the 60s TTL cache, retry ladder, spacing gate, or 30s
  timeout (all moved to `McpDataSource`)
- Does not change the agents' visible behavior against Bloomreach —
  MCP_AUTH_TYPE default preserves current shape

The plan is deliberately conservative on removal because:
- The demo path is a reliability lever (backup when live-mcp is down)
- The Bloomreach OAuth flow is real code that took real work to get right;
  deleting is expensive to reverse
- The frozen-core rule was named at the start of the tier-2 hardening arc
  and remains load-bearing for interview narrative
