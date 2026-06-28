# Study — Software design

A per-repo design audit through John Ousterhout's *A Philosophy of Software Design* (APOSD). The book's primitives — deep modules, information hiding, complexity, layering, pulling complexity down, defining errors out of existence, readability — applied to this codebase's real files.

This is the **comprehension** half. The action half lives at `.aipe/audits/design-2026-06-15.md` (per-finding refactor specs). Read this guide to understand the design shape; read the audit to act on the same findings. The book itself is excerpted at `.aipe/read-aposd/` — start there for the primitive in full; come here for "where does this primitive land in *my* code?"

---

## The through-line

> **Complexity is the enemy. Deep modules are the weapon.**

A deep module is a small interface over a big body. The fewer decisions a caller must know about, the less complexity propagates per change. APOSD's whole book is a toolkit for widening that gap between interface size and body size. This codebase teaches that lesson twice — once at the data layer, once at the agent layer — which is the single most load-bearing software-design move in the repo.

---

## Reading order

```
  ┌─ orient ──────────────────────────────────────┐
  │  00-overview.md   one-page system shape +     │
  │                   where each APOSD primitive  │
  │                   shows up                    │
  └────────────────────┬──────────────────────────┘
                       │
  ┌─ Pass 1 ───────────▼──────────────────────────┐
  │  audit.md         the 8-lens APOSD audit;     │
  │                   one section per lens; cross-│
  │                   links to pattern files      │
  └────────────────────┬──────────────────────────┘
                       │
  ┌─ Pass 2 ───────────▼──────────────────────────┐
  │  01-deep-module-data-source.md                │
  │  02-information-hiding-aptkit-bridge.md       │
  │  03-pulled-complexity-down-readndjson.md      │
  │  04-shallow-module-page-component-resolved.md │
  └───────────────────────────────────────────────┘
```

Open `00-overview.md` first if you have not seen the codebase before — it places every primitive on one map. Open `audit.md` first if you have. Pattern files are independent — read in any order.

---

## What earns its own pattern file

A *recurring design move the repo makes deliberately*. A red flag firing in one file is a lens finding; a pattern file is for the shape the codebase exercises load-bearingly. Four files survived that bar:

```
  ┌──────────────────────────────────────────────────────────┐
  │ 01 deep-module-data-source                               │
  │    a 73-LOC interface hiding a 730-LOC body              │
  │    (BloomreachDataSource + SyntheticDataSource).         │
  │    the textbook example of a deep module.                │
  ├──────────────────────────────────────────────────────────┤
  │ 02 information-hiding-aptkit-bridge                      │
  │    three 200-LOC adapter classes that bridge AptKit's    │
  │    generic primitives to Blooming's owned types.         │
  │    same APOSD lesson at a different scale.               │
  ├──────────────────────────────────────────────────────────┤
  │ 03 pulled-complexity-down-readndjson                     │
  │    one 64-LOC kernel that owns the fetch → reader →      │
  │    decoder → split('\\n') → JSON.parse loop for FOUR     │
  │    streaming surfaces.                                   │
  ├──────────────────────────────────────────────────────────┤
  │ 04 shallow-module-page-component-resolved                │
  │    a worked example — what `app/page.tsx` USED to be     │
  │    (817 LOC, 15 useState, 8 concerns at one altitude),   │
  │    why it was shallow, and the 3-hook extraction that    │
  │    fixed it. Useful as the negative-then-positive case.  │
  └──────────────────────────────────────────────────────────┘
```

Everything else lives in `audit.md` under its lens.

---

## Source + recommended reading

The primitives in these files come from John Ousterhout's *A Philosophy of Software Design* (2nd ed). Read the book; this guide does not reproduce its prose. The repo's chapter-by-chapter excerpts live at `.aipe/read-aposd/` — those are where the conceptual depth sits. The files here spend their weight on what the primitives look like *in this codebase*.

---

## Cross-links

  → `.aipe/read-aposd/` — chapter-by-chapter book treatment.
  → `.aipe/audits/design-2026-06-15.md` — action-shaped audit; per-finding refactor specs.
  → `.aipe/study-system-design/` — system architecture (services, boundaries, scaling), a different altitude.
  → `.aipe/audit-refactor-page-decomposition/` — the 5-seam reframing that retired the shallow-module case.
