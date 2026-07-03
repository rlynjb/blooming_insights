# rename via re-export

## Subtitle

**Rename-via-re-export** — a naming-only refactor that establishes an honest new name without moving the source of truth. *Language-agnostic* (any language with re-exports / module aliases: TypeScript, Python `__init__.py`, Rust `pub use`, Ruby autoload). This one is a small pattern with a specific test.

Role-vocabulary this file uses:

```
  canonical file     the file that holds the class body    (bloomreach-data-source.ts)
  honest new name    the name the pattern wants going forward  (McpDataSource)
  legacy name        the historical name, still exported      (BloomreachDataSource)
  re-export file     one-import, one-export bridge             (mcp-data-source.ts)
  call site          any file that imports the class           (connect.ts, tests, harness)
```

## Zoom out — where this concept lives

This pattern doesn't have a runtime layer — it lives in the **module-resolution layer** between your import statements and the file that actually holds the class body. When you rename something in a codebase, you have three choices: rename the class + rewrite every call site (invasive, big diff), leave it and add a comment (dishonest name persists), or add a thin re-export file and let new code use the new name (this pattern). This file is about the third choice.

```
  where the pattern lives — inside the module graph

  ┌─ Call sites (application layer) ───────────────────────────┐
  │  connect.ts, tests, fault harness, index.ts                 │
  │  each writes:                                               │
  │    import { X } from '@/lib/data-source/…'                  │
  │  where X is either:                                         │
  │    · BloomreachDataSource  (the legacy name — still works)   │
  │    · McpDataSource         (the honest new name — preferred) │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ Module resolution ────▼───────────────────────────────────┐
  │  TypeScript's re-export layer                              │ ← we are here
  │                                                             │
  │  mcp-data-source.ts  (27 LOC, ONE re-export):               │
  │     export { BloomreachDataSource as McpDataSource } from   │
  │       './bloomreach-data-source';                            │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ Canonical file ───────▼───────────────────────────────────┐
  │  bloomreach-data-source.ts (214 LOC — the class body)      │
  │  the class is still named BloomreachDataSource in-file     │
  └────────────────────────────────────────────────────────────┘
```

The class body doesn't move. The old name still works. The new name resolves to the same class through the re-export. Zero runtime cost, zero call-site churn.

## Zoom in — what this pattern is

**Rename via re-export** is a naming refactor with two properties:

1. **New name exists** — imports of `McpDataSource` resolve to the class.
2. **Old name still works** — imports of `BloomreachDataSource` continue to resolve.

Both point at the same class object. The re-export file (`lib/data-source/mcp-data-source.ts`, 27 LOC) is the whole implementation. That's it.

You use this when the current name is *inaccurate* (the class is generic; the current name pins it to one user) but the current name is *load-bearing* (many call sites, tests, docs reference it). The pattern trades a small module-resolution indirection for a rename that would otherwise touch every import.

## Structure pass — skeleton first

### Axes

The axis to trace is **"which file owns the source of truth?"**

- Above the re-export: **the call site doesn't own it** — it just imports a name.
- The re-export file: **doesn't own it either** — it forwards.
- The canonical file (`bloomreach-data-source.ts`): **owns it**. This is where the class body lives.

Same "source of truth" question, three answers, one clear owner. The re-export is a pointer, not a copy.

### Seams

The re-export file is the seam. Above it: call sites can prefer whichever name they want. Below it: the class body exists once. The axis-answer "which name are we using?" flips at exactly the re-export — the file *is* the naming boundary.

The interesting property: this seam is **swappable in one direction**. You can change what the re-export points at (e.g. later, when the class body moves to `mcp-data-source.ts` for real, the re-export could invert), but you can't change how imports work through it without breaking call sites.

### Layered decomposition

Hold "what does a call site have to change if I rename?" constant, across three scenarios:

- Rename in place, no re-export: **every call site changes** — every import statement, every doc, every comment mentioning the class.
- Rename in place, add re-export from old name → new class: **new call sites change name; old ones don't** (they resolve through the new re-export). But you have to move the class body and update the canonical file's exports.
- Rename via re-export (this repo): **no call site has to change** — old imports resolve to the canonical name in the canonical file; new imports resolve to the aliased name via the re-export.

Same question, three answers. The third has the smallest change surface, which is why this repo picked it.

## How it works

### Move 1 — the mental model

Think of the re-export like a **forwarding address for a package**. You've moved from an old address to a new one, but you don't want to notify every sender. You set up mail forwarding at the post office — new packages sent to the new address arrive; old packages sent to the old address also arrive (forwarded). The house is the same; the mail routing has a new layer. Here, `mcp-data-source.ts` is the forwarding rule; the class body is the house.

```
  the shape of the pattern — one re-export sits between two names and one class

              old name                       new name
    (already used by 15 call sites)      (preferred going forward)

              │                                │
              ▼                                ▼
      ┌───────────────┐                ┌───────────────────┐
      │  imports of   │                │  imports of        │
      │  Bloomreach   │                │  McpDataSource     │
      │  DataSource   │                │  from mcp-         │
      │  from bloom-  │                │  data-source.ts    │
      │  reach-data-  │                │                    │
      │  source.ts    │                │                    │
      └──────┬────────┘                └─────────┬──────────┘
             │                                    │
             │  resolves directly                 │  resolves through
             │  to canonical file                 │  the re-export
             │                                    │
             │                                    ▼
             │                          ┌─────────────────────┐
             │                          │  mcp-data-source.ts  │
             │                          │  export { X as Y }   │
             │                          └──────────┬──────────┘
             │                                     │
             ▼                                     ▼
      ┌────────────────────────────────────────────────────────┐
      │  bloomreach-data-source.ts                              │
      │  export class BloomreachDataSource implements DataSource│
      │  { ... 214 LOC of class body ... }                      │
      └────────────────────────────────────────────────────────┘

  BOTH names point at the SAME class object at runtime
```

### Move 2 — the walkthrough

Four moving parts: the canonical file, the re-export file, the call sites that use the old name, the call sites that use the new name.

#### The canonical file — `bloomreach-data-source.ts`

The class body. 214 LOC. Not touched by the rename.

```typescript
// lib/data-source/bloomreach-data-source.ts:121
export class BloomreachDataSource implements DataSource {
  //         ▲ the class name in the source stays "BloomreachDataSource"
  //           because renaming it would touch every existing call site.
  //           The rename lives at the export layer, not here.
  ...
}
```

**Why the class name doesn't change too.** Because you'd then have to update every `instanceof BloomreachDataSource`, every `new BloomreachDataSource(...)`, every doc comment referring to the class by name — most of which are in this same file. The re-export lets you deliver the honest new name *without* the class-body rename. Later, if you want to complete the rename, you can — but you don't have to now, and the callers are already migrated to prefer the new name.

#### The re-export file — `mcp-data-source.ts`

The whole file, 27 LOC:

```typescript
// lib/data-source/mcp-data-source.ts:1-27
// `McpDataSource` — the generic MCP client that powers the `live-mcp` mode.
//
// The class already existed as `BloomreachDataSource` and was, on inspection,
// generic (transport + retry ladder + TTL cache + spacing gate + AbortSignal
// composition). Renaming is done via re-export so all existing imports
// continue to compile. New code should prefer `McpDataSource` — the class is
// only "Bloomreach" in the sense that Bloomreach was its first user and
// still supplies the default retry-hint parser (which is HTTP-standard
// enough to work for other rate-limited servers too).
//
// This file is intentionally a thin re-export so the source of truth stays
// in one place. The plan's Phase 3 originally described extracting the class
// content into a new file; on close reading, the existing class is already
// the shape we want, and duplication would only introduce drift.

export {
  BloomreachDataSource as McpDataSource,   // ← the honest new name
  McpToolError,
} from './bloomreach-data-source';

export type {
  CallToolOptions,
  CallToolResult,
  ListToolsOptions,
} from './bloomreach-data-source';
```

**What breaks if you remove this file:** every import of `McpDataSource` becomes a compile error. Every reference in newer docs (like this study guide) becomes stale. Every reader who opens `lib/data-source/` and expects "one file per honest name" gets confused (why is there no `mcp-data-source.ts`?).

**What breaks if you inline the class body into this file and delete the canonical file:** every existing `import { BloomreachDataSource } from './bloomreach-data-source'` breaks. Every `instanceof BloomreachDataSource` in the codebase becomes wrong. The migration would need one big PR touching every call site.

The 27 LOC file is the minimum move that delivers both properties (new name exists, old name works) with the smallest possible diff.

#### The old-name call sites — resolve directly to canonical

```typescript
// lib/mcp/connect.ts:19
import { BloomreachDataSource } from '../data-source/bloomreach-data-source';
```

This is the pre-rename import shape. Points at the canonical file directly. Doesn't touch the re-export. Runtime: same class.

```typescript
// lib/data-source/index.ts:122
export { BloomreachDataSource } from './bloomreach-data-source';
```

The public re-export from the folder's `index.ts` — makes both names accessible from `@/lib/data-source`.

#### The new-name call sites — resolve through re-export

```typescript
// lib/data-source/index.ts:123
export { McpDataSource } from './mcp-data-source';
```

Public re-export from the folder. A consumer writing new code can:

```typescript
import { McpDataSource } from '@/lib/data-source';
// resolves: index.ts → mcp-data-source.ts → bloomreach-data-source.ts
```

All three re-exports refer to the same class object. At runtime, `McpDataSource === BloomreachDataSource`. TypeScript sees them as the same type.

**Verify it's the same class:** at runtime, `new McpDataSource(t, opts) instanceof BloomreachDataSource === true`. There's no class duplication; there's one class with two exported names.

### Move 2.5 — Phase A vs Phase B

**Phase A** (before Session B): the class was `BloomreachDataSource`, lived in `bloomreach-data-source.ts`, was imported by that name everywhere.

**Phase B** (Session B, current): the class body is still in `bloomreach-data-source.ts`, still named `BloomreachDataSource`. But a new file, `mcp-data-source.ts`, re-exports it under `McpDataSource`. New docs and new code prefer the honest name; old code still compiles unchanged.

```
  Phase A (pre-rename)                Phase B (current — via re-export)

  ┌─ bloomreach-       ─┐              ┌─ bloomreach-       ─┐
  │   data-source.ts    │              │   data-source.ts    │  ← unchanged
  │   ─────────────    │              │   ─────────────    │
  │   class Bloomreach  │              │   class Bloomreach  │
  │   DataSource         │              │   DataSource         │
  │   { 214 LOC body }   │              │   { 214 LOC body }   │
  └──────────────────────┘              └──────────────────────┘
                                                  ▲
                                                  │ export { X as Y }
                                                  │
                                        ┌─ mcp-data-source.ts ─┐
                                        │  27 LOC re-export     │  ← added Session B
                                        │  export {             │
                                        │    Bloomreach... as   │
                                        │    McpDataSource      │
                                        │  }                    │
                                        └───────────────────────┘

  every call site from Phase A still resolves — bloomreach-data-source.ts
  didn't move. New call sites can prefer McpDataSource.
```

**The migration cost:** 27 lines added, zero lines changed in existing files (except `index.ts` which grew one line to re-export the new name publicly).

Compare to what "rename in place" would cost: every `import { BloomreachDataSource } from ...` in the codebase (at least 15+ sites including tests) becomes an edit; every `instanceof BloomreachDataSource` becomes an edit; every doc comment referring to the class needs updating. That's a 100+ line diff for a naming-only change.

### Move 3 — the principle

**The principle:** a rename that touches call sites has a cost that scales with call-site count; a rename that doesn't touch call sites has a fixed cost (one re-export file). When the class name is inaccurate but the call-site graph is large, the re-export pattern is the small change that delivers both properties (new name preferred, old name still valid) without the graph edit.

The deeper move here is **separating identity from spelling**. The class object is the identity; `BloomreachDataSource` and `McpDataSource` are two spellings. Once you frame renames as spelling changes at the export layer, you can add spellings without breaking identity — and delete old spellings when their call sites are gone, without breaking anything else.

This is the same discipline as symlinks in a filesystem, forwarders in an email system, or route aliases in a web framework. The runtime object doesn't move; the naming layer accretes an alias, and the alias can be sunset later.

## Primary diagram

```
  the rename via re-export — three files, one class, two spellings

  ┌─ Call sites using "old" name (Bloomreach) ─────────────────┐
  │                                                             │
  │  lib/mcp/connect.ts:19                                      │
  │  lib/data-source/index.ts:122 (public re-export)            │
  │  test/data-source/bloomreach-data-source.test.ts (etc.)     │
  │                                                             │
  └──────────────────────┬──────────────────────────────────────┘
                         │
                         │  import { BloomreachDataSource }
                         │  from '@/lib/data-source/bloomreach-data-source'
                         │
                         ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  bloomreach-data-source.ts  (214 LOC — the canonical file)   │
  │                                                                │
  │  export class BloomreachDataSource implements DataSource { ... }│
  │                                                                │
  └────────────────────────────────────▲─────────────────────────┘
                                       │
                                       │  re-exports the class
                                       │  under a second name
                                       │
  ┌────────────────────────────────────┴─────────────────────────┐
  │  mcp-data-source.ts  (27 LOC — the RE-EXPORT file)           │
  │                                                                │
  │  export { BloomreachDataSource as McpDataSource } from        │
  │    './bloomreach-data-source';                                 │
  │                                                                │
  └──────────────────────────────────────────────────────────────┘
                         ▲
                         │
                         │  import { McpDataSource }
                         │  from '@/lib/data-source/mcp-data-source'
                         │        (or from '@/lib/data-source' via index.ts)
                         │
  ┌──────────────────────┴──────────────────────────────────────┐
  │  Call sites using "new" name (Mcp) — currently mostly docs   │
  │  and new code, plus the public re-export in index.ts:123     │
  │                                                                │
  └──────────────────────────────────────────────────────────────┘

  at runtime: McpDataSource === BloomreachDataSource (same class object)
  in TypeScript: `type` aliases for CallToolOptions / CallToolResult /
                  ListToolsOptions are also re-exported so both spellings
                  see the same types
```

## Elaborate

**Where the pattern comes from.** The re-export layer as a naming mechanism is as old as module systems. C's `#define OLD_NAME NEW_NAME`, Python's `__init__.py` importing from submodules and re-exporting under different names, Rust's `pub use path::to::Type as NewName`, TypeScript's `export { X as Y }` — every language with a module system has this affordance. What's specific to this pattern is *using it for renames* rather than for API exposure.

**What problem the shape solves for this repo.** During Phase 2, the class was renamed from `McpClient` (in `lib/mcp/client.ts`) to `BloomreachDataSource` (in `lib/data-source/bloomreach-data-source.ts`) *by moving the file* — because `lib/mcp/client.ts` was so small (only 15 or so call sites) that a full-file move was manageable. But by Session B, the same class is imported from 15+ places including tests and the fault-injection harness, and the new realization is that the class is generic (works against any MCP server). A move would be disruptive; a re-export is 27 LOC.

**When NOT to use this pattern.**

- If the class body needs to change too (not just the name), rename via re-export is the wrong tool — you have to touch the canonical file anyway; do the rename at the same time.
- If the old name is unambiguously wrong and every call site should stop using it, do a hard rename with a codemod. The re-export lets both names coexist; sometimes you don't want that.
- If the re-export file grows past ~30 LOC (imports, re-exports, small helpers), you're not doing this pattern anymore — you're doing an adapter file.

The line to hold: **the re-export file re-exports and does nothing else.** If it wraps the class, injects behavior, or diverges from the canonical file's shape, it's a different pattern (adapter, decorator, wrapper).

**Adjacent concepts.**

- **Deprecation** — the flip of this pattern. Old name still works but flagged with `@deprecated`. This repo hasn't marked `BloomreachDataSource` deprecated because it's not deprecated — the name is the "OAuth PKCE DCR against Bloomreach" concept, which is a real preset. The class-level name is just "McpDataSource" as the generic identity.
- **Type aliases** — `type OldName = NewClass` gets you naming interoperability at the type level, but doesn't re-export the class value. Rename via re-export is the pattern when both the value and the type need to travel under both names.
- **Barrel files** — `index.ts` re-exporting a folder's public surface is barrel-file usage, and it's how this repo makes both names available from `@/lib/data-source`. The rename-via-re-export file is a *nested* re-export inside that barrel.

## Interview defense

### Q: Why not just rename the class in place and update all callers?

**Answer:** Two reasons — one about scope, one about receipts.

Scope: renaming the class in place would touch every call site (15+ files including tests, the fault harness, and the connect module). That's a 100+ line diff for a naming-only change. The re-export is 27 lines and zero changes elsewhere.

Receipts: the rename is a claim ("this class is generic, not Bloomreach-specific"). We want to prove the claim before committing to the class-body rename. The re-export lets new code prefer `McpDataSource` — if new adapters (bearer, anonymous) work through the same class without editing it, the claim is proven. Once proven, the class body can be renamed with confidence. Doing the invasive rename first would be gambling on the claim.

Anchor: *lib/data-source/mcp-data-source.ts:11-16 — the header comment names both reasons.*

### Q: Doesn't this leave the codebase with two names for the same thing forever?

**Answer:** Only if nobody sunsets the old name. Once every call site prefers `McpDataSource`, the migration is:

1. Grep for `BloomreachDataSource` — should be a small set (mostly the canonical file and its tests).
2. Rename the class body from `BloomreachDataSource` to `McpDataSource` in `bloomreach-data-source.ts` (which at that point can be moved to `mcp-data-source.ts` for real).
3. Delete the re-export file.

Until step 3, both names work. The alternative — never having done the re-export — would be one big PR now, versus a small PR now + a cleanup later. This repo chose the second path because Session B was already touching many files, and adding a class-rename to the same PR would have widened the review surface.

Anchor: *lib/data-source/index.ts:122-123 — the public re-export where both names live side by side.*

### Q: If I'm reading `lib/data-source/` for the first time, which file has the class body?

**Answer:** `bloomreach-data-source.ts` (214 LOC). The 27-LOC `mcp-data-source.ts` re-exports it under the honest new name. This is deliberate — the class was designed to live in the "MCP client" file, but until every call site migrates, the source of truth stays in the historically-named file. The 27 LOC file is a naming-only bridge.

The header comment inside `mcp-data-source.ts` names this explicitly ("This file is intentionally a thin re-export so the source of truth stays in one place"). A reader who opens the folder in `ls` order sees:

```
  bloomreach-data-source.ts    214 LOC   ← class body
  fault-injecting.ts            176 LOC   ← decorator
  index.ts                       125 LOC   ← factory + barrel
  mcp-data-source.ts              27 LOC   ← re-export
  synthetic-data-source.ts       516 LOC   ← second adapter
  types.ts                        71 LOC   ← the port
```

The 27 LOC size is itself a hint — a file that small is either a re-export, a type-only file, or a stub. Opening it confirms: pure re-export.

Anchor: *lib/data-source/mcp-data-source.ts:18-22 — the entire body of the file is a `export { X as Y }` statement.*

## See also

- [audit.md](./audit.md) — lens 7 (readability/obviousness) names the class-name-vs-directory-name friction; this pattern is the deliberate choice behind it.
- [01-port-adapter-decorator-preset-factory.md](./01-port-adapter-decorator-preset-factory.md) — the pattern this rename is part of; `McpDataSource` is the honest name for the adapter role in the port family.
- [02-auth-strategy-injection.md](./02-auth-strategy-injection.md) — same pattern at `lib/mcp/auth-providers/bloomreach.ts` (16 LOC re-export pointing at `lib/mcp/auth.ts:259` LOC of class body).
- `.aipe/read-aposd/` (chapter on Choosing Names) — naming discipline; the honest-name-later principle.
