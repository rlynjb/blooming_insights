# WAL, Durability, and Recovery

## Subtitle

How a database survives a crash and how it gets restored when it doesn't · Industry standard.

## Zoom out, then zoom in

```
  Zoom out — where durability sits in a normal app

  ┌─ App ──────────────────────────────────────────┐
  │  COMMIT — caller expects "it's safe now"       │
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ Database ─────────▼───────────────────────────┐
  │  ★ WAL + DURABILITY + RECOVERY ★               │
  │  write-ahead log (fsync to disk, before commit) │
  │  buffer pool (in-memory pages, dirty + clean)   │
  │  checkpointer (flush dirty pages periodically)  │
  │  recovery (replay WAL after crash)              │
  │  backup + PITR                                  │
  └────────────────────┬───────────────────────────┘
                       │
  ┌─ Disk ─────────────▼───────────────────────────┐
  │  WAL files + data files + backup snapshots     │
  └────────────────────────────────────────────────┘
```

### Verdict for this codebase

**Not yet exercised — no WAL, no fsync, no backup story.** The state hierarchy here is:

- **In-memory Maps** — wiped on every cold start and every deploy. No durability claim, none expected.
- **`.investigation-cache.json` and `.auth-cache.json`** — dev-only JSON files, no fsync, no atomic rename. Tear-on-crash caught by `JSON.parse` try/catch (`lib/state/investigations.ts` L17 / `lib/mcp/auth.ts` L120).
- **`bi_auth` cookie** — durable for ~10 days, AES-GCM encrypted. The "WAL" is the browser's cookie jar. Recovery is "user re-authenticates."
- **Committed JSON fixtures** (`lib/state/demo-*.json`) — durable via git. The "backup" is `git reflog`. The "PITR" is `git checkout <sha>`.

### When this becomes load-bearing

The moment user data lives in our process and a process crash would lose work. Until then, every write is either ephemeral (Maps) or browser-side (cookie) or human-managed (committed fixtures).

```
  features that would force a real durability story

  any user-generated content (saved insights, comments, notes)
     → can't lose it on a deploy. needs durable storage with fsync.

  any audit log of agent actions
     → loss is a compliance failure. needs durable append-only log.

  long-running async jobs (batch briefings, exports)
     → state must survive the function instance dying mid-job.
       needs durable queue with at-least-once delivery.

  paid-tier customer data
     → SLA implies recovery time objective (RTO) and recovery point
       objective (RPO). that means: backups, PITR, tested restore.
```

## Structure pass

Skipped — no codebase instance.

## How it works

### Move 1 — the mental model

A database has two storage tiers: the **buffer pool** (in-memory, fast, lossy on crash) and the **disk** (slow, durable). The write path is:

1. App calls `UPDATE`
2. Engine modifies the in-memory page (dirty)
3. Engine appends an entry to the **write-ahead log** describing the change
4. WAL gets `fsync`'d to disk
5. ONLY NOW does COMMIT return

The dirty page can wait — it'll be flushed by the checkpointer later, or never at all. The WAL entry on disk is the durability promise. If the process crashes before the dirty page is written, recovery replays the WAL and rebuilds the page from the log.

```
  the pattern — write path, with WAL

       App:    UPDATE x SET v = 5

       Engine:
         buffer pool [page]   modify v: 4 → 5   ← in-memory only
              │
              ▼
         WAL append           "page P: v 4→5"
              │
              ▼
         fsync(WAL)           ← this is the durability fence
              │
              ▼
       COMMIT returns           ← from here, even a crash recovers

       (much later)
         checkpointer         flush page P to data file
         (asynchronous, batched, much cheaper than per-commit)
```

The whole reason WAL exists is **the sync write to the WAL is small and sequential**, while a sync write of the data page is large and random. WAL converts random writes into sequential ones — that's the entire performance trick.

### Move 2 — the moving parts

**Move 2a — the WAL itself.** Append-only file. Every change goes on the end. Bounded in size by rotation (Postgres: 16MB segments). Replayed on crash. Streamed to replicas (see 08).

**Move 2b — checkpointing.** The background process that flushes dirty pages to disk so the WAL can be truncated. Too frequent: I/O storm. Too rare: long recovery time.

**Move 2c — `fsync` and its lies.** `fsync(fd)` is supposed to mean "the OS has confirmed this is on disk." In practice, hardware can lie — disks cache writes in their own RAM. Postgres's `synchronous_commit=off` accepts this risk explicitly; the default (`on`) does not. The classic "Postgres fsync bug" of 2018 was about how the kernel handles fsync errors, and it cost reputable companies real data.

**Move 2d — backups + PITR.** Periodic full backups + the WAL stream between them lets you restore to any point in time. RPO (recovery POINT objective — how much data you can lose) is set by backup + WAL ship cadence. RTO (recovery TIME objective — how long restore takes) is set by backup size and WAL replay speed.

```
  bridge: think of git as a primitive WAL. every commit is an append to a
          log of changes. you can `git checkout <sha>` to recover any prior
          state. you can `git push` to ship the WAL to another replica.
          this is the same shape; databases just do it on hot data.
```

### Move 3 — the principle

**Durability is what `COMMIT` actually means.** Without a WAL, `COMMIT` is a lie — the engine has to flush a whole page to disk on every commit, which is unacceptably slow, or it has to defer the write, which means a crash loses committed data. The WAL is the trick that makes "fast" and "durable" compatible: the cost of commit is one sequential append, not many random writes. Get this contract right and the rest of the database can be optimized freely; get it wrong and committed data isn't actually committed.

## Primary diagram

Skipped — no codebase instance to recap.

## Implementation in codebase

### Use cases

- **Auth cookie** is the only piece of state with a real durability claim — durable for 10 days, encrypted, owned by the browser.
- **Dev write paths** (`writeFileSync` in `lib/state/investigations.ts` and `lib/mcp/auth.ts`) are best-effort, no fsync, no atomic rename. Tear-on-crash recoverable by re-authenticating.
- **Committed demo fixtures** are durable via git; the "backup" is git history.

### The closest cousins, ranked

```
  lib/mcp/auth.ts — the closest thing to a WAL

  prod path:
    fn() mutates an in-memory store
    on exit: encryptStore(store) → cookies().set(AUTH_COOKIE, ...)
              │
              └─ the browser now persists the encrypted blob for 10 days.
                 the "WAL" is the cookie jar. recovery on session loss is
                 "user re-authenticates" — i.e. start over, not log replay.

  dev path:
    patchState(...) → writeAll(...) → writeFileSync(CACHE_FILE, json)
              │
              └─ no fsync. node's writeFileSync calls write(2) on the FD,
                 which OS-buffers the data. a crash between the write and
                 the OS flush loses the change. acceptable here because
                 the cache is reconstructible by re-authenticating.
```

```
  lib/state/investigations.ts  (lines 30–41)

  export function saveInvestigation(insightId, events) {
    mem.set(insightId, events);                ← in-memory write, dies on crash
    if (PERSIST) {
      const all = readJson(CACHE_FILE);
      all[insightId] = events;
      try {
        writeFileSync(CACHE_FILE, JSON.stringify(all));   ← read-modify-write
      } catch { /* best effort */ }                       ← writes can SILENTLY
                                                            fail; no rollback,
                                                            no retry, no alert
      }
  }
       │
       └─ this is the OPPOSITE of WAL. it's a read-the-whole-file, modify-in-
          memory, write-the-whole-file-back pattern. on dev, with one writer,
          fine. if two writers raced, one would clobber the other entirely.
          no atomic-rename (write to tmp + rename) and no fsync — a power loss
          mid-write leaves a torn file. caught by the JSON.parse try/catch in
          readJson L13-19, which treats a corrupt cache as empty.
```

```
  lib/state/demo-*.json — git as backup

  /Users/rein/Public/blooming_insights/lib/state/demo-insights.json
  /Users/rein/Public/blooming_insights/lib/state/demo-investigations.json
       │
       └─ the only "durable" data in the repo. backed up by git, recoverable
          by checkout, ship-stream is `git push`. for committed read-only
          fixtures this is fine; for live data it would be absurd.
```

## Elaborate

The WAL is one of the foundational ideas in storage engineering — predates relational databases (System R, IBM, late 1970s). Every modern engine has one: Postgres WAL, MySQL InnoDB redo log, SQLite WAL mode, RocksDB WAL, Kafka commit log. The pattern is so general that Kafka took it and built an entire messaging system on the same primitive ("the log is the source of truth, consumers replay").

For blooming insights, the day persistence enters the picture, the lift is small: pick Postgres, get WAL for free, configure backup cadence, document RPO/RTO, test the restore. None of this is novel — it's table stakes for any serious data layer. The reason it's absent today is the reason "we don't have a database" is fine today: nothing is at stake.

Cross-link: `08-replication-and-read-consistency` — the WAL is also how replication ships. `study-distributed-systems` for the broader log-as-truth pattern.

## Interview defense

**Q: "How do you handle durability today?"**
We don't, because nothing here needs to be durable. Application state lives in `Map`s that wipe on deploy. The auth cookie is the one piece of state that survives — durable for 10 days, encrypted, owned by the browser not by us. The dev-only JSON files are best-effort, no fsync, recoverable by re-authenticating. The committed demo fixtures are durable via git. There's no WAL, no backups, no recovery procedure — because there's no data we'd be sad to lose.

Diagram: the lifetime hierarchy from section 01, with each layer's durability annotated.

Anchor: `lib/state/investigations.ts` L30-41 — the closest write-path in the repo; explicitly best-effort.

**Q: "If you added user data, what's your minimum durability story?"**
Postgres. Daily snapshot backups, WAL streamed to S3, target RPO 1 hour and RTO 4 hours for a side project. Test the restore once a quarter — an untested backup is a hope, not a backup. I wouldn't build any of this myself; I'd use Neon or Supabase, which give you WAL-shipped backups out of the box.

Diagram: the WAL + checkpoint + backup picture.

Anchor: today, no DB; this is hypothetical and I'd flag it.

## See also

- `08-replication-and-read-consistency` — replication is WAL shipping
- `05-transactions-isolation-and-anomalies` — COMMIT is what WAL backs
- `01-database-systems-map` — what little durability we do have
- `study-distributed-systems` — log-as-truth pattern at a higher altitude

---
