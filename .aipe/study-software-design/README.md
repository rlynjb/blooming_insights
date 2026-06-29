# study — software design (AOSD applied to this codebase)

This guide reads the **blooming insights** repo through John Ousterhout's *A Philosophy of Software Design* (AOSD) — module depth, information hiding, layering, pulled complexity, error definitions, readability — and walks the design moves the repo actually exercises today.

The through-line:

> **Complexity is the enemy. Deep modules are the weapon. Pull complexity down so callers stay clean. Hide the decisions that would otherwise force two modules to change together.**

This guide teaches the primitives briefly and spends its weight on the findings about *your* code — real file paths, real line ranges, ranked by what costs the most to ignore.

## Source

The conceptual framework comes from John Ousterhout's *A Philosophy of Software Design* (Yaknyam Press, 2nd ed., 2021). The book is short, opinionated, and the canonical reference. Read it. This guide does not restate it — it applies it.

For the full conceptual treatment of any primitive named here, follow the cross-link to the matching chapter in `.aipe/read-aposd/`. The guide names the primitive and points at the chapter; the chapter teaches it.

## How to read this folder

Two passes, like every audit-style study guide in this family (see `me.md` → AUDIT-STYLE GENERATORS):

```
  Pass 1 — the audit (one file, every lens walked)
  ──────────────────────────────────────────────────
  audit.md                  ← walks 8 AOSD lenses against this repo

  Pass 2 — discovered design moves (one file each)
  ──────────────────────────────────────────────────
  01-port-and-adapter-data-source.md       deep module · ports & adapters
  02-streaming-ndjson-kernel.md             pulled-complexity-down · shared kernel
  03-aptkit-bridge-information-hiding.md   information hiding · adapter bridge
  04-page-decomposition-and-hooks.md       resolved shallow module · extract hook
  05-session-keyed-state.md                 information hiding · correctness boundary
```

**Reading order if you have 20 minutes.** Open `00-overview.md` for the big-picture diagram and the through-line, then `audit.md` for the lens-by-lens summary, then drop into the Pass 2 file whose primitive interests you most. The file list itself is a teaching artifact — a senior engineer scanning the names sees what's interesting about this repo before opening anything.

## Cross-links

  → `.aipe/read-aposd/` — the conceptual book chapters. Every Pass 2 file cross-links to the chapter that teaches its primitive in full.
  → `.aipe/study-system-design/` — the architecture altitude. Where `study-software-design` looks at *modules and interfaces*, `study-system-design` looks at *services and boundaries*. Different altitude, same repo.
  → `.aipe/audits/design-*.md` — the action-shaped companion. This guide explains; `audit-software-design` produces per-finding refactor specs you can execute.

## What's not here

  → Algorithm / DSA depth — lives in `.aipe/study-dsa-foundations/`.
  → Service-level architecture — lives in `.aipe/study-system-design/`.
  → Component-level a11y / visual concerns — lives in `.aipe/audits/a11y-*.md`.

If you find yourself reaching for one of those while reading here, the rule is altitude: module / interface / complexity → here; service / architecture → system-design; reusable algorithm → dsa-foundations.
