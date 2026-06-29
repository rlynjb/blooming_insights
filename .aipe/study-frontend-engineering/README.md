# study-frontend-engineering — blooming_insights

The framework-and-platform layer of `blooming_insights`, audited for what it actually does — not what a generic Next.js + React app could do.

## What this folder is

Audit-style two-pass output produced by `/aipe:study-frontend-engineering`:

- **Pass 1 — `audit.md`** — eight lenses walked once against the repo. Every finding grounded in `file:line`. Lenses with nothing to report are named `not yet exercised`, not padded.
- **Pass 2 — `01-…` and `02-…`** — discovered patterns the repo exercises load-bearingly. Each uses the full concept-file template (Zoom out → Structure pass → How it works → Primary diagram → Elaborate → Interview defense → See also).

## Reading order

```
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │   1.  00-overview.md                                     │
  │       The whole frontend layer in one page —             │
  │       rendering mode, state architecture diagram,        │
  │       network seam diagram, the three highest-leverage   │
  │       patterns named.                                    │
  │                                                          │
  │   2.  audit.md                                           │
  │       Pass 1. The 8-lens walk: rendering-and-reactivity, │
  │       state-architecture, component-architecture,        │
  │       data-fetching-and-cache, routing-and-navigation,   │
  │       styling-and-design-system, browser-platform-and-   │
  │       build, frontend-red-flags-audit.                   │
  │                                                          │
  │   3.  01-ndjson-stream-reader-hook.md                    │
  │       The streaming substrate — fetch + ReadableStream + │
  │       NDJSON, wrapped in a custom hook that owns a       │
  │       state dispatcher. One 64-LOC kernel, four          │
  │       consumers, two distinct StrictMode adaptations.    │
  │                                                          │
  │   4.  02-progressive-skeleton-with-stepper.md            │
  │       The perceived-performance pattern — four reveal    │
  │       surfaces (stepper, coverage grid, skeletons,       │
  │       status log) staged across the 30-60s monitoring    │
  │       runtime so the user always has something specific  │
  │       to look at.                                        │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
```

## What sits where (partition)

```
  Topic ownership — this guide vs. neighbors

  this guide                       neighbor                        owns
  ─────────────────────────────    ─────────────────────────       ────────────────
  rendering mode of THIS repo      study-runtime-systems           event loop, async
  fetch() / NDJSON consumer        study-networking                wire / HTTP semantics
  state architecture (in browser)  study-system-design             state at the system level
  Skeleton / loading composition   study-performance-engineering   FCP / LCP / CLS numbers
  inline-style + design tokens     study-security                  XSS / CSP / token trust
  component boundary placement     study-software-design           module depth, deep modules
  hand-rolled stream reader        study-testing                   test design + AI-eval seam
```

A finding belongs in this guide when it's about a **frontend-specific pattern or seam** — how the framework decides what to render, how server state crosses into client state, how the design system scales, what platform APIs the repo touches. The mechanics underneath those choices belong to the neighbors.

## What this folder does NOT cover

- Bundle-size, FCP, LCP, CLS as numbers → `study-performance-engineering`.
- Token storage, CSP, OAuth trust boundaries → `study-security`.
- The `AgentEvent` / `BriefingEvent` contract as a system seam → `study-system-design`.
- Module-depth analysis on `readNdjson` and the hooks → `study-software-design`.
- The event-loop semantics of `await reader.read()` → `study-runtime-systems`.
- HTTP/1.1 chunked-encoding mechanics → `study-networking`.
- The 221-passing test suite + the AI-eval seam → `study-testing`.

## On UPDATE

When the codebase grows a new frontend pattern, add an `0N-…md` file using the same template. When an existing pattern's implementation changes, update its file in place. When a pattern is genuinely gone from the codebase (not just refactored), remove its file. Re-walk `audit.md` against current evidence on every UPDATE; the cross-links to the pattern files should refresh too.
