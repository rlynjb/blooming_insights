# Study — Frontend Engineering (blooming_insights)

The frontend layer of this repo: how the framework renders, where state lives, how server-state crosses into client state, how the design system scales, what platform APIs the repo touches, how routes compose, and how the bundle is built.

This is **your home turf** (7+ years frontend, Vue/React). The guide leans on that — no on-ramp for what a component or hook is. Lead with what THIS repo does differently from the React you wrote at FedEx, Amazon, or CoreWeave.

## Reading order

| step | file | what you get |
|------|------|--------------|
| 1 | [`00-overview.md`](./00-overview.md) | One-page orientation: rendering mode in one sentence, state architecture in one diagram, network seam in one diagram, the three highest-leverage patterns named |
| 2 | [`audit.md`](./audit.md) | The 8-lens frontend audit, every claim grounded in `file:line`. The final lens ranks frontend risks by user-visible consequence |
| 3 | [`01-ndjson-stream-reader-hook.md`](./01-ndjson-stream-reader-hook.md) | Deep walk on the load-bearing primitive: `lib/streaming/ndjson.ts` (64 LOC kernel) + `useInvestigation` (the data-fetch hook 4 consumers reuse the shape of) |
| 4 | [`02-progressive-skeleton-with-stepper.md`](./02-progressive-skeleton-with-stepper.md) | Deep walk on the 4-tier progressive composition: `Skeleton` + `ProcessStepper` + `CoverageGrid` + `StatusLog` — how a 30-90s wait becomes a UI that animates from the first 100ms |

Skim order if you only have 10 minutes: `00-overview.md` → the diagrams in `01` and `02`.

## What the two pattern files cover (and why they earn a file)

This is an audit-style topic. Pass 1 (`audit.md`) walks the 8 lenses; Pass 2 (these pattern files) deep-walks the patterns this repo actually exercises. Two patterns made the cut:

**`01-ndjson-stream-reader-hook`** — passes the load-bearing test ("if you stripped this pattern out, what specifically would the UI lose?") with: streaming agent reasoning as a first-class surface. Without the kernel, the product can't "show its work" — the whole `coordinator → monitoring → diagnostic → recommendation` pipeline becomes a 30-90s blank screen. Passes the recognition test: any senior engineer reads `readNdjson + useInvestigation` and sees the shape.

**`02-progressive-skeleton-with-stepper`** — passes the load-bearing test: the perceived-instant feel during the long agent run. Without the 4-tier composition (skeleton sized like the diagnosis, stepper-as-router, coverage tiles streaming individually, status log animating), the user stares at a spinner. Passes the recognition test: the pattern has a name in the field (progressive disclosure / shape-mirroring skeletons + status stepper).

Patterns that DIDN'T earn a file (deliberately):

- **Three-ring state ownership** — covered as the diagram in `00-overview.md` and lens 2 of `audit.md`. It's a structural choice rather than a self-contained pattern.
- **OAuth reconnect policy** — `useReconnectPolicy` (123 LOC) is real, but it's a recovery mechanism for one external dependency's quirk (the alpha Bloomreach server revoking tokens after minutes), not a generalizable frontend pattern. Lens 4 + lens 8 of `audit.md` cover it.
- **Demo / live mode toggle** — covered in lens 2 of `audit.md` as the only `localStorage` key. It's a switch, not a pattern.
- **Page decomposition (817 → 461 LOC + 3 hooks)** — this is the refactor that *enabled* the patterns above, not a pattern to study. The history is in `.aipe/audit-refactor-page-decomposition/`.

## Cross-links to neighboring guides

The frontend partition is sharp on purpose — these concerns belong elsewhere:

- **`study-system-design`** — where state lives at the system level (auth cookies, in-memory caches on the route side, the multi-agent orchestration that produces the events these hooks consume)
- **`study-software-design`** — module depth, interface design, complexity primitives (Ousterhout applied to `useInvestigation` as a deep module; the 64-LOC kernel as an info-hiding boundary)
- **`study-runtime-systems`** — the event loop, microtask scheduling, async cancellation semantics under `fetch` + `ReadableStream` + `useEffect` cleanup
- **`study-networking`** — HTTP chunked transfer, `EventSource` vs `fetch+ReadableStream` tradeoffs, the wire-format choice that made NDJSON the answer
- **`study-performance-engineering`** — FCP / LCP / TTI / bundle size as numbers; the streaming UI's perceived-vs-measured performance
- **`study-security`** — XSS surfaces (the `TraceContent` markdown-ish renderer at `components/investigation/TraceContent.tsx`), CSP, token storage (sessionStorage vs cookies), the cross-instance handoff via URL params and what it exposes
- **`study-testing`** — the integration-test harness that pins the NDJSON event contract these hooks consume (`test/api/briefing.integration.test.ts`, `test/api/agent.integration.test.ts`)
- **`study-debugging-observability`** — how the `StatusLog` doubles as in-product observability (every tool call's duration + result is visible to the user)

## What's NOT here, on purpose

- No "best practices" recap of React. You know React.
- No vendor-anchored framing ("Tailwind does X, Next.js does Y"). The patterns survive if you swap the framework.
- No before/after refactor stories — that's `.aipe/audit-refactor-page-decomposition/` and `.aipe/audit-refactor-eval-substrate/`.

## On UPDATE

Per `me.md` → AUDIT-STYLE GENERATORS → On UPDATE: regenerate `audit.md` against current evidence (all 8 lenses re-walked, `file:line` references refreshed), add a Pass 2 pattern file when the codebase grows a new frontend pattern that passes the load-bearing + recognition tests, update existing pattern files when implementations change, and remove pattern files only when the pattern is genuinely gone from the codebase.
