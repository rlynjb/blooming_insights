# study — frontend engineering

The framework-and-platform layer of blooming_insights: how Next.js 16 + React 19 turn agent output into pixels, where the state graph lives, how the streaming NDJSON seam is consumed, and what design system the components actually share.

Reader posture: you've shipped 7+ years of Vue and React. This guide skips the "what's a hook" on-ramp and goes straight to what THIS repo does.

## Reading order

  1. `00-overview.md` — one-page orientation. Rendering mode in a sentence, state graph in a diagram, network seam in a diagram, the three highest-leverage patterns named with file paths.
  2. `audit.md` — Pass 1. The 8-lens audit walked against real evidence. `not yet exercised` where the repo doesn't touch the lens.
  3. Pattern files (Pass 2) — one per load-bearing frontend pattern this repo actually exercises. Each uses the full `format.md` template.

## Discovered pattern files

Named after the pattern, not the lens. A senior reader skimming this list should recognize what the repo does.

  - `01-ndjson-stream-reader-hook.md` — one kernel (`readNdjson`) shared across every streaming surface. Fetch + reader + decoder + split-on-newline + JSON.parse + dispatch. The seam that lets 4 different consumers share the same 64 LOC.
  - `02-progressive-skeleton-with-stepper.md` — 4-tier progressive composition on the feed. ProcessStepper + CoverageGrid + Skeleton stack + StatusLog trace fill in from stubs to loaded as the stream reports each level of detail.
  - `03-settings-modal-with-localstorage-persistence.md` — new in Session D. Modal writes a config override to localStorage; streaming hooks pick it up on the next fetch as an HTTP header; unset falls through to env. Zero server state, zero React context.

## Cross-links to neighbor guides

Frontend-engineering owns the framework-and-platform layer only. Adjacent generators own their own seams:

  - Rendering-pipeline event loop → `study-runtime-systems`
  - Wire format (NDJSON, SSE, streaming semantics) → `study-networking`
  - FCP / LCP / bundle-size measurement → `study-performance-engineering`
  - XSS / CSP / token-storage trust boundaries → `study-security`
  - Deep modules vs shallow, information hiding → `study-software-design`
  - System-level state ownership and boundaries → `study-system-design`
  - Test isolation, MSW seams, eval harness → `study-testing`

If a finding is about "which layer decides X" or "what should the seam contract be," it lives in one of those. If it's about "how does React turn a stream into progressive UI in this repo," it lives here.
