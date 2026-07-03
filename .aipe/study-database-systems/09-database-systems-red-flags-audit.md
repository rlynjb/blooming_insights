# 09 · Database-systems red flags — the ranked audit

*Storage-engine and consistency risks in this codebase, top-down*

## Zoom out — where this concept lives

This file ranks every storage-engine and consistency risk the earlier
files surfaced. Each finding lives at a specific tier of the
persistence hierarchy from `01-database-systems-map.md`. Ranking is
by **consequence** — how bad it is when the mechanism fails, times
how likely the failure is under this repo's actual workload.

```
Zoom out — where each red flag sits

┌─ Client tier ──────────────────────────────────────────────┐
│  localStorage (bi:mode, bi:mcp_config)                     │
│  sessionStorage (bi:insight:*, bi:diag:*, bi:inv:*:*)      │
└──────────────────────────┬─────────────────────────────────┘
                           │  ← RED FLAG #6 (bearer in plaintext)
                           │  ← RED FLAG #7 (cross-tab race)
┌─ Server tier ─────────────▼────────────────────────────────┐
│  in-mem Map<sessionId, SessionFeed>                        │
│  60s response cache                                        │
└──────────────────────────┬─────────────────────────────────┘
                           │  ← RED FLAG #2 (putInsights race)
                           │  ← RED FLAG #4 (memory leak in cache)
                           │  ← RED FLAG #5 (cache key instability)
┌─ Cookie tier ─────────────▼────────────────────────────────┐
│  bi_auth (AES-256-GCM), bi_session (UUID)                  │
└──────────────────────────┬─────────────────────────────────┘
                           │  ← RED FLAG #1 (AUTH_SECRET rotation)
┌─ Git tier ────────────────▼────────────────────────────────┐
│  eval/baseline.json, eval/receipts/, lib/state/demo-*.json │
└──────────────────────────┬─────────────────────────────────┘
                           │  ← RED FLAG #3 (demo lag untracked)
                           │  ← RED FLAG #8 (stale baseline lock-in)
```

## Zoom in — the pattern

**The pattern:** *ranked risks, each anchored to a real file:line
and a real workload assumption.* This is not a laundry list — it's
the top 8 findings that would matter first if you were on-call for
this app.

## Structure pass — one axis across the findings

**Axis: "what triggers this failure in production?"** (trigger)

```
Trace the trigger for each red flag

  #  Finding                              Trigger                       Blast radius
  ─  ──────────                           ───────                       ────────────
  1  AUTH_SECRET rotation logs everyone   env var change                all users
     out
  2  putInsights race on concurrent       user opens 2 tabs on same     ONE session
     briefings                             session, both trigger
                                            briefing
  3  demo replica has no lag metric       time (unbounded staleness)    demo users
  4  response cache is a slow memory      long-running process +        one instance
     leak                                  unique args
  5  cache key is JSON.stringify —        caller reorders arg keys      one call
     order-dependent
  6  bearer token in localStorage in      any XSS in the app            one user
     plaintext
  7  cross-tab race on bi:mode            user opens 2 tabs, changes    mild UX
                                            mode in one
  8  baseline.json can be regenerated     dev runs eval:baseline on     CI silently
     from a regressed candidate            a bad run                     passes
```

The seams that matter:

  → **Trigger scope determines priority.** Findings #1 and #6 are
    triggered by security events (env change, XSS) — they're low-
    frequency but high-blast-radius. #2 and #3 are triggered by
    normal use — high frequency, medium blast radius. Together
    they're the top 3.

  → **The blast-radius / probability tradeoff.** #1 is "all users
    logged out" but very rare; #2 is "one session's briefing wiped"
    and probably happens weekly. Both deserve fixing; #1 needs a
    plan, #2 needs a code change.

The **most load-bearing property** in this ranking: the top three
findings all sit at DIFFERENT tiers (#1 cookie, #2 in-memory, #3
git). That means fixing one doesn't help the others — they're
independent failure modes and need independent fixes.

## How it works

### Move 1 — the ranking framework

Each finding gets four things:

  1. **The failure.** What breaks, in one sentence.
  2. **The trigger.** What has to happen for the failure to fire.
  3. **The blast radius.** Who sees it (one user / one session / one
     instance / all users / CI silently).
  4. **The evidence.** File:line + the fix if any exists in code.

Rank by (blast radius × trigger probability), tie-broken by "how
surprising the failure is when it fires."

### Move 2 — the eight findings, ranked

#### Finding 1 — The auth cookie IS your database. Rotation logs everyone out.

**Severity: CRITICAL** — the entire production durability story
depends on `AUTH_SECRET`.

**Evidence:** `lib/mcp/auth.ts:51-79`. The AES-256-GCM key is
`sha256(AUTH_SECRET)`. `decryptStore()` catches any error (bad
tag, wrong key, malformed) and returns `{}`:

```typescript
// lib/mcp/auth.ts:69-79
function decryptStore(token: string): Store {
  try {
    const buf = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', aesKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as Store;
  } catch {
    return {}; // tampered, rotated-secret, or corrupt cookie → treat as no auth
  }
}
```

**Failure:** rotate `AUTH_SECRET` in Vercel and every logged-in user's
`bi_auth` cookie becomes undecodable. The catch block silently
returns `{}` and the app treats them as "not authenticated." No
warning, no migration path.

**Trigger:** env var change (rotation, mistake, staging → prod copy
gone wrong).

**Blast radius:** all users. Every session dies at once.

**Fix path:** dual-key support — try the new key, fall back to the
old key for one grace period, then drop the old key. This is what
real key-rotation looks like. Not implemented today. Given
`AUTH_SECRET` rotation is a rare event and re-auth is "the user does
OAuth again," the accepted cost is high but manageable.

**Why it's #1:** because the cookie is the ONLY production
durability layer. If it becomes unreadable, there is no backup —
there's no other tier where the OAuth state lives in production.

#### Finding 2 — `putInsights` has a between-request race.

**Severity: HIGH** — concurrent briefings for the same session wipe
each other.

**Evidence:** `lib/state/insights.ts:57-71`. The function unconditionally
clears the inner Maps then writes items:

```typescript
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  const s = sessionState(sessionId);
  s.insights.clear();        // ← wipe (no transaction)
  s.anomalies.clear();       // ← wipe (no transaction)
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

**Failure:** user opens two tabs, both trigger a briefing. The
second briefing's `.clear()` wipes the first's writes; readers land
in interleaved state.

**Trigger:** two overlapping briefings on the same sessionId within
the same warm instance's lifetime.

**Blast radius:** one session — the two briefings interfere but no
other user is affected.

**Fix path:** an append-only shape with a `briefingId` field on
each insight, plus reads filter by the latest briefingId. That's
MVCC-by-convention (walked in `06-locks-mvcc-and-concurrency-control.md`).
Alternative: a per-session mutex.

**Why it's #2:** because the trigger is realistic (any user with
two tabs) and the current mitigation is "the workload is serial in
practice" — a hope, not a guarantee.

#### Finding 3 — The frozen replica has no lag metric.

**Severity: HIGH** — demo mode can replay arbitrarily old snapshots
with no warning.

**Evidence:** `app/api/mcp/capture-demo/route.ts:34-58`. Writes
`lib/state/demo-insights.json` unconditionally. No timestamp check.
No expiry. No metric anywhere in the read path.

**Failure:** the demo file was captured 6 months ago; a demo user
sees content that doesn't reflect current business reality. No
warning banner. No automatic re-capture. The mode reads happily.

**Trigger:** time. Every day the file gets older; the trigger fires
continuously.

**Blast radius:** all demo-mode users, plus any observer using
`?demo=cached` as a reliability fallback during an outage.

**Fix path:** add a `capturedAt` field to the payload; the demo
route reads it and either warns ("this snapshot is 60+ days old") or
refuses to serve above a threshold. Cheap fix; the missing piece is
the metric, not the mechanism.

**Why it's #3:** it's less severe than #2 because "stale demo" isn't
a data-loss event, but it's the most likely to actually happen — the
snapshot goes stale automatically over time, whereas the race in #2
needs a specific concurrency pattern.

#### Finding 4 — The response cache is a slow memory leak.

**Severity: MEDIUM** — real but only surfaces on a long-lived
process with unbounded arg diversity.

**Evidence:** `lib/data-source/bloomreach-data-source.ts:122, 186`.
Every unique cache key writes an entry with `expiresAt`; nothing
ever removes expired entries. Expired entries sit in the map until
overwritten by an identical call.

**Failure:** in a long-running process (dev server that stays up
for days), unique tool calls accumulate. Each is 60 seconds "valid"
then stays as dead weight forever.

**Trigger:** long process uptime + high arg diversity. On Vercel
warm instances that cycle every few hours, this rarely bites. On
dev servers, might grow to hundreds of dead entries.

**Blast radius:** one instance's memory. Bounded by process
lifespan.

**Fix path:** either (a) a background sweep that evicts expired
entries, or (b) an LRU cap on the map size. Neither is implemented.

**Why it's #4:** low blast radius, real but slow to bite. Would be
higher if the process lifespan were longer.

#### Finding 5 — The cache key is JSON.stringify — order-dependent.

**Severity: MEDIUM** — silent cache misses on structurally-identical
args with different key orders.

**Evidence:** `lib/data-source/bloomreach-data-source.ts:144`:

```typescript
const cacheKey = `${name}:${JSON.stringify(args)}`;
```

`stringify({a:1, b:2})` and `stringify({b:2, a:1})` are different
strings. Two callers that assemble the same args in different key
orders miss the cache and both fire live calls.

**Failure:** cache hit rate lower than expected; two agents on the
same instance ask for the same tool + args but pay full latency on
both.

**Trigger:** any caller code that doesn't produce args in a stable
order. The agents themselves DO produce stable orders (the tool
schemas define the shape), so this is currently benign — but there's
no enforcement.

**Blast radius:** one call at a time. Wasted latency, not incorrect
results.

**Fix path:** replace `JSON.stringify(args)` with a canonical-JSON
library or a sorted-key stringify helper. One-line fix if you cared.

**Why it's #5:** benign today, dangerous if a future caller doesn't
know the invariant. It's a "correctness by convention" hazard.

#### Finding 6 — Bearer token in localStorage in plaintext.

**Severity: MEDIUM (security)** — deliberate design choice; still
worth naming.

**Evidence:** `components/settings/McpConfigModal.tsx:16-23` and
`lib/mcp/config.ts:134`:

```typescript
// components/settings/McpConfigModal.tsx:16 (comment)
// Persistence: writes to localStorage['bi:mcp_config'] via
//   ...
// Bearer stored in localStorage; not encrypted (unlike bi_auth)
```

**Failure:** any XSS in the app reads the bearer token from
localStorage and exfiltrates it. Unlike `bi_auth` which is HttpOnly
and encrypted, `bi:mcp_config` is fully readable from JS.

**Trigger:** any script-injection vulnerability. Given this is
Next.js with React auto-escaping, the trigger requires either a
dangerous `dangerouslySetInnerHTML` or a supply-chain compromise.

**Blast radius:** one user's MCP bearer token. Consequence depends
on the token's scope on the MCP server.

**Fix path:** the modal comment notes it as future work: "encrypt
bearer token into a short-lived cookie server-side so it doesn't
ride the header plaintext on every subsequent request." Both parts
matter — the storage AND the transport are plaintext.

**Why it's #6:** it's a deliberate accepted tradeoff (portfolio
visitors plug in their own MCP server without server-side account
setup), not a bug. The comment names it. But an interviewer will
ask about it.

#### Finding 7 — Cross-tab race on `bi:mode`.

**Severity: LOW** — mild UX bug, no data loss.

**Evidence:** `app/page.tsx:79, 108`. Reads `localStorage.getItem`
on mount; writes `localStorage.setItem` on switch. No `storage`
event listener means the OTHER tab doesn't know its mode is stale.

**Failure:** user has two tabs open. Switches mode in tab A. Tab B
still shows the old mode; the next fetch from tab B goes to the
wrong data source.

**Trigger:** two tabs open at once, mode switched in one.

**Blast radius:** one user's UX. No data loss.

**Fix path:** add `window.addEventListener('storage', …)` in
`app/page.tsx` to sync mode changes across tabs. Standard pattern.

**Why it's #7:** ranked below the correctness findings because it's
UX-only.

#### Finding 8 — Baseline can be regenerated from a regressed candidate.

**Severity: LOW** — process risk, not a runtime failure.

**Evidence:** `eval/baseline.eval.ts:41-65`. `npm run eval:baseline`
happily reads the latest receipts and writes `baseline.json`. If
the latest run has regressed and you run baseline instead of gate,
you lock in the regression.

**Failure:** dev runs `eval:baseline` on a bad run; the CI gate
now compares future candidates against the bad baseline; regressed
runs pass silently.

**Trigger:** dev workflow mistake. Not a code bug.

**Blast radius:** CI regression detection is silently broken.

**Fix path:** add a "sanity check" — refuse to write baseline.json
if any per-dim pass rate is below some floor. Or gate baseline
writes on a manual `--force` flag.

**Why it's #8:** it's a process risk, not a runtime bug. Named for
completeness. The multi-baseline support (`BASELINE_LABEL=v2`)
partially mitigates by making the previous baseline recoverable via
`baseline-v1.json`.

### Move 2.5 — the not-yet-exercised findings (deliberately absent)

Findings you might expect that AREN'T here, and why:

  → **"No connection pool for the DB"** — no DB, so no pool.

  → **"Missing indexes on foreign keys"** — no schema, no keys.

  → **"N+1 in an ORM"** — no ORM. There IS an N+1-shaped pattern in
    the agent loop (walked in `04-query-planning-and-execution.md`),
    but it's not the same failure mode.

  → **"Long-running transactions holding locks"** — no locks, no
    long transactions. The only transaction-shaped code path
    (`withAuthCookies`) is bounded by request duration.

  → **"Replication lag alerts"** — the demo replica has no
    monitoring at all; that's finding #3 above.

  → **"Backup restore never tested"** — the git-tag rollback story
    IS testable (`git reset --hard <tag>` is deterministic), but
    nobody has practiced it recently. Worth naming but not a "red
    flag" — it's a chaos-testing improvement.

### Move 3 — the principle

**Every no-DB codebase has these findings, in some form.** When you
skip the database, you skip the durability guarantees, the
concurrency control, and the backup/restore machinery — and you
have to reinvent each one, usually less rigorously. The findings
above aren't unique to this repo; they're the shape of what you
lose. The good news is that most of them are cheap to fix; the bad
news is that the fixes are per-tier and can't be delegated to a
platform.

## Primary diagram — the red-flag map on the persistence hierarchy

```
Findings, placed on the persistence hierarchy

  ┌── Tier 1: localStorage ──────────────────────────────────────┐
  │                                                                │
  │   ● Finding #6 (bearer in plaintext, no encryption)           │
  │   ● Finding #7 (cross-tab race on bi:mode)                    │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘
  ┌── Tier 2: sessionStorage ────────────────────────────────────┐
  │                                                                │
  │   (no findings — per-tab scope contains all races)             │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘
  ┌── Tier 3: in-memory Map ─────────────────────────────────────┐
  │                                                                │
  │   ●●● Finding #2 (putInsights race — top 3)                  │
  │   ●   Finding #4 (response cache memory leak)                 │
  │   ●   Finding #5 (cache key JSON order-dependence)            │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘
  ┌── Tier 4: signed cookies ────────────────────────────────────┐
  │                                                                │
  │   ●●● Finding #1 (AUTH_SECRET rotation — CRITICAL)           │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘
  ┌── Tier 5: file system (dev) ─────────────────────────────────┐
  │                                                                │
  │   (no findings — dev-only, non-production)                    │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘
  ┌── Tier 6: git-committed ─────────────────────────────────────┐
  │                                                                │
  │   ●●● Finding #3 (demo replica lag untracked — top 3)         │
  │   ●   Finding #8 (baseline regenerable from regressed run)    │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘

  the top 3 findings sit on THREE DIFFERENT tiers.
  fixing one doesn't reduce risk on the others.
```

## Elaborate

**How ranking was done:** blast radius × trigger probability. Data-
loss > UX bugs. Silent failure > loud failure. Findings that reveal
a missing PRIMITIVE (a lock, a lag metric) ranked above findings
that are one-line fixes.

**The top-3 finding pattern.** Notice that the top three findings
each map to a classical DB primitive that's missing: #1 is
"backup/rotation without dual-key support," #2 is "transactions,"
#3 is "replication monitoring." That's not a coincidence — those
are exactly the three things you get for free with a real DB and
have to invent when you don't have one.

**What this doesn't cover:** everything under
`study-security/` (auth flows, XSS surfaces), `study-testing/` (eval
coverage), and `study-distributed-systems/` (warm-instance
coordination). Cross-links exist; don't re-teach.

## Interview defense

**"What are the top 3 risks in this system's storage layer?"**

Answer: *"Ranked. First, the `bi_auth` cookie is the only production
durability tier — rotating `AUTH_SECRET` silently logs everyone out
because `decryptStore` catches the bad-tag error and returns an
empty store. A dual-key grace period would fix it. Second,
`putInsights` in `lib/state/insights.ts` races on concurrent
briefings for the same session — the `.clear()` then loop `.set()`
pattern has a window where a reader sees partial state. An
append-only shape with a `briefingId` would fix it. Third, the
frozen demo replica has no lag metric — `lib/state/demo-insights.json`
gets captured manually and never checked for staleness. Adding a
`capturedAt` field and a threshold warning would fix it."*

**"Which is most likely to bite you?"**

Answer: *"#3 — the demo replica staleness. It fires continuously as
time passes; the other two need specific triggers. Nobody in the
codebase looks at when the file was last captured, so the demo mode
will happily replay six-month-old data with no warning. The
top-severity one is #1 because the blast radius is 'all users,' but
the top-probability one is #3."*

**"How would you fix all three at once?"**

Answer: *"You can't — they're on three different tiers. #1 is a
cookie-crypto change, #2 is an in-memory shape change, #3 is a
git-artifact metadata change. That's actually the story of no-DB
codebases: every durability concern lives at its own tier, and each
one needs its own solution. A real DB coalesces them."*

The load-bearing skeleton part interviewers routinely forget:
**the top 3 findings live on 3 different tiers.** That's not just
a fun observation — it's the reason "just add a database" is a real
option here. A single storage engine would collapse the 3 problems
into 1 well-understood surface with tested tooling.

## See also

  → `01-database-systems-map.md` — the tier map each finding sits on
  → `05-transactions-isolation-and-anomalies.md` — Finding #2's
    deeper walkthrough
  → `07-wal-durability-and-recovery.md` — Findings #1 and #8's
    durability context
  → `08-replication-and-read-consistency.md` — Finding #3's
    replication context
  → `study-security/` — Finding #6's security context (cross-link,
    don't re-teach)
  → `study-testing/` — Finding #8's eval-substrate context
