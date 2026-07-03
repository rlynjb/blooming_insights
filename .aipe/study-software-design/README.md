# Study — Software Design (blooming insights)

The AOSD primitives from John Ousterhout's *A Philosophy of Software Design*, applied to this repo. Complexity is the enemy; deep modules are the weapon. Every finding here points at a real file.

## Source & attribution

This guide teaches Ousterhout's ideas in original words and anchors them to your code. For the full book-length treatment of any primitive (deep modules, information hiding, layering, error definition), read *A Philosophy of Software Design*. Nothing here reproduces the book; the value here is in the findings about your codebase.

Companion generator: `.aipe/read-aposd/` teaches the primitives abstractly; this guide applies them to your files.

## Through-line

```
  Complexity is the enemy — deep modules are the weapon

  ┌──────────────────────────────────────────────────────────────┐
  │  the more a module hides, the less its callers must know     │
  │  the less its callers must know, the fewer places a change   │
  │  amplifies to — that is what "less complex" means            │
  └──────────────────────────────────────────────────────────────┘

  the two shapes to recognize on any pull request:

     deep                                  shallow
     ────                                  ───────
     small interface, big body             wide interface, small body
     hides many decisions                  exposes the internals
     callers stay simple                   callers replicate the mechanism
     one change stays local                one change amplifies

  every finding in this guide is a bet on which shape a piece of
  your code is closest to — and, when it's the wrong one, the
  specific move that would flip it
```

## Reading order

```
  1.  audit.md              start here — 8 lenses across your repo
                            (complexity → deep-vs-shallow → info hiding
                            → layers → pull-down → errors → readability
                            → red-flags checklist)

  2.  01-port-adapter-decorator-preset-factory.md
                            the DataSource seam: five roles in one
                            300-LOC directory. the load-bearing win
                            (5 uses without a caller-surface change)

  3.  02-auth-strategy-injection.md
                            three wildly different auth flows behind
                            one 10-method interface. the deepest module
                            in the repo per LOC hidden

  4.  03-rename-via-reexport.md
                            how you sunset a misnomer without moving
                            290 LOC and 15 import sites

  5.  04-client-server-contract-module.md
                            one file owns the shape of a header —
                            client encodes, server decodes, env still wins
                            when the header is absent
```

## What you'll learn about this repo

The top finding is **not** a bug — it's a **rank-order call**:

1. **The load-bearing win (tier-2 story):** the DataSource port has 5 uses of the seam without a caller-surface change (Olist add / Olist remove / Synthetic add / FaultInjecting decorator / McpDataSource rename). Textbook deep-module payoff, receipts included.

2. **The load-bearing legacy:** 9 files (~1000 LOC) in `lib/agents/*-legacy.ts` are still on disk, imported only by 2 test files. Rollback receipt while the AptKit migration bedded in — now due to leave. Same finding as the previous audit; still the #1 fix.

The rest of the audit lenses (leakage, layers, error handling, readability) find small stuff — this codebase is honest about its shape.

## Cross-links

- `.aipe/read-aposd/` — the book, taught abstractly. Use it when the concept lead-in isn't enough.
- `.aipe/study-system-design/` — architecture altitude (services, boundaries, scaling). This guide stops at module/interface level.
- `.aipe/study-dsa-foundations/` — reusable algorithm curriculum. Not covered here.
- `.aipe/audits/refactors/design-*.md` — the action-shaped companion. Same 8 lenses, per-finding refactor specs instead of teaching.

## About this generator

Two passes:

- **Pass 1** — `audit.md`: fixed shape, 8 lenses, one section per lens. Every repo gets this.
- **Pass 2** — the numbered pattern files: repo-specific. Named after design moves this codebase actually exercises. Different repo → different file list.

Pattern files use the `format.md` template: Subtitle → Zoom out → Structure pass → How it works → Primary diagram → Elaborate → Interview defense → See also.

Both passes reconcile against the code, not against this guide's template. When the code changes and this guide doesn't, re-run the generator.
