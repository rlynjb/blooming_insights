# study-system-design — blooming insights

Where components live in this repo, how data and work move, and where the boundaries carry weight. Two passes, one folder.

## Reading order

```
  1. 00-overview.md              the whole system in one diagram + legend
  2. audit.md                    the 8-lens walk of what the repo does
  3. 01-*.md through 07-*.md     one file per load-bearing pattern
```

Start at `00-overview.md`, skim `audit.md`, then read the pattern files that light up something you want to reason about.

## The pattern files

Named after what the repo actually does — not after the lens they were found under.

- `01-datasource-seam.md` — the port (`DataSource`) + three adapters + one decorator; **four shipments through the same seam, zero caller changes**. The load-bearing receipt of the whole codebase.
- `02-aptkit-boundary.md` — three-class bridge (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`) between Blooming's app and `@aptkit/core`'s provider-neutral primitives.
- `03-ndjson-streaming.md` — one `readNdjson` kernel + one `AgentEvent` contract; four surfaces (briefing, agent, capture, chat) all speak it.
- `04-oauth-boundary.md` — PKCE + Dynamic Client Registration through `OAuthClientProvider`; the encrypted-cookie vs dev-file split lives at the trust boundary.
- `05-demo-vs-live-mode.md` — three-mode runtime toggle (`demo | live-bloomreach | live-synthetic`) picked at the route with `bi:mode`; demo replays a committed snapshot, live-synthetic swaps the DataSource adapter.
- `06-budget-and-observability.md` — `BudgetTracker` threaded through `AgentHooks` gates model dispatch; `onCapabilityEvent` forwards the trace to the eval + ledger.
- `07-eval-regression-gate.md` — golden cases + rubric judge + baseline.json + a CI-invocable gate that blocks PRs on per-dimension regression.

## Cross-links to neighboring foundation guides

System-design owns architectural boundaries and tradeoffs. Mechanism-level teaching belongs to the neighboring generators:

- `study-database-systems` — engine internals of any datastore. Blooming has none today (in-memory `Map`s keyed by session id, gitignored JSON in dev), so the database guide is thin here.
- `study-data-modeling` — the shape of the `Insight` / `Anomaly` / `Diagnosis` / `Recommendation` / `AgentEvent` types. When you want to know *why the schema looks like this*, that guide has it.
- `study-distributed-systems` — coordination correctness across processes. Blooming runs single-process on Vercel with session-scoped in-memory state; the distributed guide notes what would need to change if the state grew a network hop.
- `study-runtime-systems` — the Vercel edge runtime, `AsyncLocalStorage`, `AbortSignal`, `ReadableStream`. That guide covers *how* those primitives execute; this one covers *where* they are used and what boundary they sit behind.
- `study-networking` — HTTP semantics, streaming transports, the MCP `StreamableHTTPClientTransport`. That guide covers wire behavior; this one covers which components exchange bytes across the wire.
- `study-software-design` — code-level patterns (deep modules, layering, information hiding). System-design points at the boundaries; software-design walks how the code on each side is shaped.
