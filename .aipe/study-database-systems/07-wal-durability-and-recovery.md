# WAL, durability, and recovery

*Durability + recovery / Language-agnostic*

## Zoom out, then zoom in

You know how Postgres flushes every commit to a write-ahead log before returning "success," so a crash mid-transaction can be replayed from the log? That's durability. This repo has no WAL, no fsync, no recovery loop. What it has is one AES-256-GCM encrypted cookie that survives on the client for ten days, some committed JSON in git, and a very deliberate policy of "the server owns no durable state." This file names each durability primitive and where the boundary sits.

```
  Zoom out — where "durability" lives in this repo

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  bi_auth cookie (AES-256-GCM, 10 days, httpOnly)           │  ← the ONLY prod durability
  │  bi_session cookie (opaque UUID, session)                  │
  │  localStorage: bi:mode                                     │
  │  sessionStorage: stashed Insight for click-through nav     │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌─ Service (Vercel warm instance) ▼─────────────────────────┐
  │                                                            │
  │  session Map, TTL cache, McpClient cache                   │
  │  → ALL wiped on cold-start / redeploy                      │
  │                                                            │
  │  dev-only: .investigation-cache.json, .auth-cache.json     │
  │  → gitignored, local filesystem only                       │
  │                                                            │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌─ git repository ────── ▼──────────────────────────────────┐
  │  ★ lib/state/demo-*.json      committed snapshots           │  ← deploy-time durability
  │  ★ eval/baseline.json         committed regression ref     │
  │  ★ eval/receipts/*.json       committed per-run scores     │
  │  ★ git tags (study-pre-regen-2026-07-03)  = "backup"       │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** The server's serverless instances are *ephemeral by contract* — Vercel gives you no promise about their lifetime, no attached disk. So durability had to move somewhere else. Two places: the encrypted cookie on the client (for per-user state that has to survive a redeploy) and git (for state that has to survive the app's death). Everything else is a cache with extra steps.

## Structure pass

**Axis to hold constant: what survives a redeploy?**

```
  "does this survive `vercel deploy`?" — traced across the state primitives

  ┌─ session Map<sessionId, SessionFeed> ─────────────────────┐
  │  in-memory on the warm instance                            │  → NO. wiped every redeploy,
  │  insights.ts:14                                            │    every cold-start.
  └───────────────────────────────────────────────────────────┘
      ┌─ BloomreachDataSource TTL cache ───────────────────────┐
      │  in-memory on the warm instance                         │  → NO. wiped every redeploy.
      │  bloomreach-data-source.ts:122                          │    (60s TTL anyway.)
      └────────────────────────────────────────────────────────┘
          ┌─ AsyncLocalStorage auth store ─────────────────────────┐
          │  per-request only                                        │  → NO. dies at
          │  auth.ts:47                                              │    request end.
          └────────────────────────────────────────────────────────┘
              ┌─ bi_auth cookie ───────────────────────────────────────┐
              │  on the client, AES-256-GCM, 10-day max-age              │  → YES. redeploy
              │  auth.ts:38-104                                          │    doesn't touch it.
              └────────────────────────────────────────────────────────┘
                  ┌─ committed JSON in git ─────────────────────────────────┐
                  │  demo-*.json, baseline.json, receipts/*.json              │  → YES. survives
                  │                                                            │    everything.
                  └────────────────────────────────────────────────────────────┘
```

The seam that flips the axis is **the network boundary from server to client, plus the deploy-time boundary from repo to running app**. Nothing in the middle survives a redeploy. Two survivors: the client's cookie, and git.

## How it works

### Move 1 — the mental model

Standard shape of durability in a real database:

```
  standard WAL kernel

  1. write intent to log (append-only, sequential)
  2. fsync the log → durable on disk
  3. apply change to the in-memory buffer
  4. lazy checkpoint → flush buffer to data pages later
  5. on crash: replay log from the last checkpoint

  key property: (2) happens BEFORE returning "committed"
```

This repo's equivalent:

```
  this-repo "durability" kernel

  in-memory Maps       ← no durability layer at all
       │
       │  (nothing to fsync)
       │
       ▼
  bi_auth cookie       ← the "log" — writes are batched to the response cookie
       │                  once per request via withAuthCookies flush
       │
       ▼
  browser              ← the "durable disk" — the client holds it for 10 days
       │
       ▼
  next request         ← the "recovery" — decrypt on read, seed ALS store

  git repo             ← the "backup" — committed JSON survives everything
```

The load-bearing insight: **the cookie IS the WAL**. Every write to auth state is buffered in ALS during the request, then serialized-and-encrypted-and-set into the cookie at request end (`auth.ts:86-104`). The cookie makes it to the browser, becomes durable there. On the next request, `withAuthCookies` decrypts it into a fresh ALS store — that's the "recovery." The whole "log-then-apply" shape is there, just at the request granularity instead of the transaction granularity.

### Move 2 — the primitives walked

**`bi_auth` — encrypted-cookie durability.**

```ts
// lib/mcp/auth.ts:38-49
const PERSIST = process.env.NODE_ENV === 'development';
const CACHE_FILE = join(process.cwd(), '.auth-cache.json');
const memStore = new Map<string, SessionAuthState>();

interface RequestStore { store: Store; dirty: boolean }
const requestStore = new AsyncLocalStorage<RequestStore>();
const AUTH_COOKIE = 'bi_auth';
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 10; // 10 days, matches token lifetime
```

Three backends selected by env:
- **dev** → gitignored file `.auth-cache.json` (survives dev-server restarts).
- **test** → in-memory `memStore` (isolated per test run).
- **prod** → encrypted `bi_auth` cookie on the client.

The prod backend is the only one that matters for the durability story. AES-256-GCM (`auth.ts:62-79`) with a 12-byte random IV and 16-byte auth tag; the key is `sha256(AUTH_SECRET)`; a tampered or corrupt cookie decrypts to `{}` and the app treats it as "no auth" (`auth.ts:69-79`). The cookie carries the OAuth client info from Dynamic Client Registration, the tokens (access + refresh), and the PKCE `code_verifier` — everything a warm-instance-lost server needs to keep the OAuth flow alive across a serverless cold-start.

The 10-day max-age matches Bloomreach's token lifetime — outliving that would just mean carrying dead tokens.

**Cookie flush = commit.**

```ts
// lib/mcp/auth.ts:86-104
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

Line 91: BEGIN — decrypt-and-load. Line 92: run the request with ALS scoping. Line 93-102: COMMIT — if any write happened during the request (`ctx.dirty === true`), re-encrypt and set the cookie. The response header is the durability barrier — once the browser receives it, the write survives redeploy, cold-start, and this warm instance's death.

Notice what's *not* here: no fsync, no checkpoint, no partial-write recovery. The cookie is either fully written (browser stores it, next request sees it) or it isn't (network error mid-response, next request sees the pre-write value). Because the OAuth SDK is idempotent — it can redo the DCR, re-request the tokens — losing a write is recoverable by rerunning the handshake. This is the design's tolerance for "no true WAL."

**In-memory state = zero durability by design.**

```ts
// lib/state/insights.ts:14
const state = new Map<string, SessionFeed>();

// lib/data-source/bloomreach-data-source.ts:122
private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

Both die on redeploy, both die on cold-start. This is *accepted*. The insight surface is not audit data — it's ephemeral analyst thinking, and re-running the briefing is the right recovery move. The 60s TTL cache is by definition a cache; losing it costs one round-trip's worth of latency. Neither of these needs to survive.

The client-side fallback for insight PK lookups (`useInvestigation.ts` stashes the whole `Insight` into `sessionStorage`) is what makes "server has no state anymore" survivable at the UX layer — the user clicks a card, the client already has the row, the server rebuilds the anomaly from `?insight=` (see `resolveAnomaly` at `app/api/agent/route.ts:35-49`, third fallback branch).

**`eval/baseline.json` — durability via commit-to-git.**

```ts
// eval/gate.eval.ts:52-61
const label = process.env.BASELINE_LABEL ?? '';
const baselineFile = label ? `baseline-${label}.json` : 'baseline.json';
const baselinePath = resolve(EVAL_DIR, baselineFile);
let baseline: Baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
} catch {
  throw new Error(`Missing baseline at ${baselinePath}. Build one with:  npm run eval:baseline`);
}
```

The regression-gate's "reference row" is a committed JSON file. Durability is `git commit`. Recovery is `git checkout`. Backups are branches and tags. This is filesystem-as-committed-database at its most literal: a single JSON row whose durability guarantee is "as long as the git remote is intact."

Same story for `eval/receipts/*.json` (28 rows today, one per case × runId) — each is a self-contained committed file. Losing one means losing that scored case; you re-run the eval to regenerate. `lib/state/demo-*.json` is the same shape — committed snapshots, regenerable via the dev-only "capture" button.

**Git tags as backup/rollback.**

```
  git tags in this repo (partial):
    study-pre-regen-2026-06-28
    study-pre-regen-2026-07-03
    rehearse-pre-regen-2026-06-28
    study-rehearse-pre-regen-v1.69.2
```

These are named restore points before large study/rehearse regenerations. `git checkout study-pre-regen-2026-07-03` is the human-scale equivalent of a PITR (point-in-time recovery). The retention policy is manual (tags don't garbage-collect), the granularity is coarse (one tag per major regen), and there's no automation — but it *works* and it's cheap.

**Dev-only file cache = local-filesystem durability.**

```ts
// lib/state/investigations.ts:1-9
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '../mcp/events';

const PERSIST = process.env.NODE_ENV === 'development';
const CACHE_FILE = join(process.cwd(), '.investigation-cache.json');
const DEMO_FILE = join(process.cwd(), 'lib/state/demo-investigations.json');
```

`.investigation-cache.json` is written from the dev branch of `saveInvestigation` (`investigations.ts:30-41`). It's gitignored — a dev-machine convenience for iterating on investigations without re-running the agents. Production is stateless (Vercel filesystem is read-only, and `PERSIST` is false anyway).

### Move 2 variant — the load-bearing skeleton

Minimum viable durability layer:

1. **The bi_auth cookie itself.** Remove it (or drop `AUTH_SECRET`) and OAuth breaks the moment the warm instance turns over — the PKCE `code_verifier` from the `authorize` request is gone before the `callback` runs. This is the *only* production durability primitive that the app cannot function without.
2. **The `ctx.dirty` gate.** Remove it and every request sets the cookie, whether or not it wrote — wastes response headers, slows every request slightly. Keep it.
3. **The commit-to-git story for `eval/baseline.json`.** Remove it and the regression gate has no reference; every PR is either "no gate" or "run a fresh baseline every time" (which defeats the point).

Everything else — the demo snapshot, the dev file cache, the git tags — is convenience or backup.

### Move 3 — the principle

**Push durability to the layer that already has it.** This repo doesn't try to build a WAL over Vercel's stateless serverless — it *inherits* durability from the browser (cookie) and from git (commit). The result is an app with zero server-side persistent storage that still recovers from redeploys, cold-starts, and instance death. The tradeoff is real: you can't store anything the client can't hold, and you can't durably persist anything that has to change between deploys. Every state design decision downstream of that reads as the natural consequence: sessions are ephemeral, insights are re-generated, investigations are re-runnable, baselines are git rows.

## Primary diagram

```
  Durability, from a write to "safe past a redeploy"

  ┌─ per-request auth write ───────────────────────────────────┐
  │                                                             │
  │  request enters                                             │
  │    │                                                        │
  │    ▼                                                        │
  │  withAuthCookies:                                           │
  │    decrypt bi_auth   ─► ctx.store ─► requestStore.run(ctx)  │
  │                                          │                  │
  │                                          ▼                  │
  │                                      OAuth SDK                │
  │                                       many readState /       │
  │                                       patchState calls        │
  │                                       (all hit ctx.store)     │
  │                                          │                    │
  │                                          ▼                    │
  │    if ctx.dirty: encrypt(ctx.store) ─► set bi_auth cookie    │
  │    │                                     │                    │
  │    │                                     ▼                    │
  │    ▼                                Set-Cookie header          │
  │  response leaves                    (COMMIT boundary)          │
  │                                          │                    │
  │                                          ▼                    │
  │                                     browser stores it         │
  │                                     for 10 days                │
  │                                                                │
  │  next request: decrypt ─► same round begins                    │
  │                                                                │
  │  lib/mcp/auth.ts:86-104                                        │
  └───────────────────────────────────────────────────────────────┘

  ┌─ deploy-time / eval durability (git) ──────────────────────┐
  │                                                             │
  │  npm run eval:baseline                                      │
  │    → reads eval/receipts/*.json (28 rows)                   │
  │    → aggregates via computeBaseline(runId, receipts)        │
  │    → writes eval/baseline.json                              │
  │    → committer commits it                                   │
  │                                                             │
  │  npm run eval:gate                                          │
  │    → reads eval/baseline.json (durable "row")               │
  │    → compares to candidate → passes/fails PR check          │
  │                                                             │
  │  eval/baseline.eval.ts:56-58                                │
  │  eval/gate.eval.ts:53-91                                    │
  │                                                             │
  │  backup / rollback: git tags                                │
  │    study-pre-regen-2026-07-03  ← human-scale PITR anchor    │
  └────────────────────────────────────────────────────────────┘

  ┌─ what doesn't survive (accepted losses) ───────────────────┐
  │                                                             │
  │  session Map<sessionId, SessionFeed> — wiped on redeploy    │
  │    → recovery: user re-runs briefing (agent is idempotent)  │
  │                                                             │
  │  BloomreachDataSource cache — wiped on redeploy             │
  │    → recovery: 60s of extra Bloomreach hits                 │
  │                                                             │
  │  in-flight requests — dropped mid-flight on redeploy        │
  │    → recovery: client's auto-reconnect on `invalid_token`   │
  │      (see app/page.tsx feed logic)                          │
  │                                                             │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The interesting philosophical point: **"the WAL is on the client"** is a pattern local-first apps have been articulating for years. This repo is not local-first — it's a serverless web app talking to a remote SaaS — but it borrowed the exact same durability idea for the auth layer. Encrypt the state, ship it to the client, let the client be the durable disk. The tradeoff you accept is a bounded state size (cookies are limited, browsers cap them at ~4KB per; check the encrypted-store size stays under that) and a max-age you have to pick honestly.

The eval-layer story is a different kind of durability: *versioning by commit*. `eval/baseline.json` isn't just a persisted row — it's a row whose *edits are code-reviewed*. Every time a baseline changes, someone opens a PR to change it, and the change is auditable in git history. That's a stronger durability guarantee than most production databases give you (you can `SELECT * FROM audit_log`, but you can't `git blame` a Postgres row without extra tooling).

`study-system-design` owns the higher-level question of "which datastore was chosen" (answer: none for local state, Bloomreach for source-of-truth). Here the point is narrower: **the two durability primitives that DO exist are picked deliberately**, and they cover exactly the two failure modes the app can't ignore (OAuth surviving cold-start; eval baseline surviving PR review).

### `not yet exercised`

- **Write-ahead log (per-transaction append + fsync barrier).** No engine.
- **Fsync / synchronous_commit / group commit.** No engine.
- **Checkpoints and dirty-page flushing.** No engine.
- **Backup automation (pg_dump, base backup + WAL archive).** Manual git tags only.
- **Point-in-time recovery, PITR windows.** Coarse via `git checkout <tag>`.
- **Replication as durability (log-shipping to standby).** See `08-replication-and-read-consistency.md`.
- **Crash recovery replay from the log on startup.** Cookie decrypt on request-start is the analog, at request granularity.

## Interview defense

**Q: "How does this app persist data?"**

Model answer: "Almost none of it, and that's deliberate. There are two durable primitives. One: the `bi_auth` cookie at `lib/mcp/auth.ts:38-104` — AES-256-GCM encrypted, 10-day max-age, holds OAuth client info + tokens + PKCE verifier. That survives redeploys because it's on the client. Everything the server needs to keep OAuth alive across a cold-start goes in this cookie. Two: committed JSON in git — `lib/state/demo-*.json` for demo replay, `eval/baseline.json` for regression-gate reference, `eval/receipts/*.json` for per-run scores. Those survive because they're in the repo. Between the two, the entire session Map, TTL cache, and MCP client cache are wiped on every redeploy — accepted, because the recovery move is 'user re-runs the briefing' and the agent is idempotent."

Diagram to sketch: the "per-request auth write" flow — decrypt into ALS, mutate, dirty-check, encrypt-and-set on response.

**Q: "What's the WAL analog here?"**

Model answer: "The cookie flush at the end of `withAuthCookies` in `auth.ts:86-104`. Standard WAL is 'append to log, fsync, then return commit.' Here it's 'buffer to ALS store during the request, encrypt into cookie on response.' The response's Set-Cookie header is the commit barrier. It's request-granular rather than transaction-granular, but the shape is identical: you don't return success until the durable layer has the write. And like a real WAL, if the response never reaches the client (network error), the write is lost — but the OAuth handshake is idempotent, so recovery is just 'redo the flow.' That's the design's acceptance for not having a true fsync."

Anchor: cookie Set-Cookie header = commit barrier; response reaches client = "fsynced."

**Q: "How would you back up production data?"**

Model answer: "There isn't any. Bloomreach owns the source of truth — customer data, event streams — and I don't back that up because I don't run it. My app's durable state is (1) `bi_auth` cookies on user browsers, which I can't back up and don't need to (they expire in 10 days and re-auth is fine), and (2) whatever's committed in the repo, which is backed up by the git remote. If I ever added server-side persistence — a Postgres for cross-session analytics, say — that's when I'd need backup automation. Right now the 'backup' is `git push origin main` plus tags like `study-pre-regen-2026-07-03` as human-scale restore points."

Anchor: no server-side durable state → no backup needed. Backup = git remote + tags.

## See also

- `01-database-systems-map.md` — the full storage picture this file zooms in on.
- `05-transactions-isolation-and-anomalies.md` — the atomicity story that pairs with cookie-as-commit.
- `06-locks-mvcc-and-concurrency-control.md` — the AsyncLocalStorage pattern that makes the cookie-flush idempotent.
- `08-replication-and-read-consistency.md` — how the demo snapshot acts as a read replica.
