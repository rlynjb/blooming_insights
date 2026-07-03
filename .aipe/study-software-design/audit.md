# The audit — 8 lenses through this codebase

Walks the AOSD design lenses against the current repo. Each lens
names findings with `file:line`. When a finding is significant
enough to have its own deep walk, this file cross-links to the
pattern file (`01-` through `06-`) instead of restating it.

The lens order is diagnostic → structural → readability →
capstone. Complexity first (where does it hurt?), depth and
hiding next (how do we bury it?), layering and pull-down after
(who should own the decision?), errors and readability last
(when the shape is right, is the surface honest?). Red flags at
the end as the actionable index.

---

## 1. complexity-in-this-codebase

The diagnostic overview. Three symptoms to locate: amplified
change (one edit touches many files), high cognitive load (the
module nobody wants to touch), unknown-unknowns (surprises
hiding behind an interface).

**Three highest-complexity hotspots today, ranked:**

1. **`lib/agents/*-legacy.ts` — 9 files, ~1000 LOC of frozen
   duplication.** Every one is a shadow of its non-legacy sibling:
   `base-legacy.ts` (270) shadows `base.ts` (14 — the aptkit
   bridge), `monitoring-legacy.ts` (138) shadows `monitoring.ts`
   (116), etc. The legacy chain runs a hand-rolled ReAct loop; the
   non-legacy chain delegates to aptkit through the three-class
   adapter bundle (see `02-aptkit-bridge.md`). Only two test files
   (`test/agents/base.test.ts`, `test/agents/synthesis-instruction.test.ts`)
   still import from them, and they import from `base-legacy.ts`
   only. **Symptom: cognitive load.** A reader arriving at
   `lib/agents/` sees the same agent named twice and has to work
   out which one is live. **Fix: delete the seven unreferenced
   files; keep `base-legacy.ts` only if the two tests can't be
   rewritten against the live path this week.**

2. **`app/page.tsx` — 461 LOC.** Down from a heavier version (the
   `useBriefingStream`, `useDemoCapture`, `useReconnectPolicy`
   hooks were extracted — see `lib/hooks/`). What's left is
   *layout code*: header + mode toggle + two-column shell + the
   coverage-grid section + the query-box section. Individually
   each block is fine; together it's still a long file with three
   concerns interleaved. **Symptom: amplified change.** A
   header-copy edit and a stepper-status edit sit in the same
   file. **Fix: extract `<FeedHeader />`, `<FeedModeToggle />`,
   and `<FeedLayout />` — the concerns are already visible in the
   comments.**

3. **`lib/data-source/synthetic-data-source.ts` — 516 LOC.** By far
   the longest single file in `lib/data-source/`. It's a fixture
   generator that produces plausible EQL responses for the agents
   to reason over — a lot of it is data tables (event catalogues,
   segment shapes, plausible customer counts). Reads dense but
   the split between "shape of a synthetic response" and "the
   generator that emits it" isn't visible from the file layout.
   **Symptom: unknown-unknowns.** Editing a synthetic response
   shape risks silently breaking a golden case. **Fix: split
   `synthetic-fixtures.ts` (the data) from
   `synthetic-data-source.ts` (the adapter).**

The number that ties them together: three files carry ~2000 LOC.
Cut the legacy chain and you're back under a healthy total.

## 2. deep-vs-shallow-modules

Modules ranked by depth — functionality relative to interface
size. Deep = big body, small surface; shallow = surface nearly as
complex as the body (classitis).

**Deepest module — the standout example.**
`DataSource` (`lib/data-source/types.ts` — 71 LOC total, of which
the interface is `callTool` + `listTools`, two methods, ~15 LOC of
signature). Under that interface sits **~740 LOC of adapter work**:
`BloomreachDataSource` (214), `SyntheticDataSource` (516),
`FaultInjectingDataSource` (167 — see `03-fault-injecting-decorator.md`).
The client (the agents) only ever holds a `DataSource` reference;
they don't know which adapter they're calling. This is the deepest
module in the repo and the seam has now shipped in four live uses
(Olist add, Olist remove, Synthetic add, FaultInjecting wrap). Deep
walk: `01-datasource-port.md`.

**Shallowest module — the worst offender.**
`lib/agents/base.ts` — 14 LOC. Exports one constant (`AGENT_MODEL`)
and one type alias (`McpCaller`). Nothing else. Its interface is
100% of its body. This is textbook classitis — a module that
exists to be named. Compare against `base-legacy.ts` (270 LOC of
the hand-rolled ReAct loop it *used* to hold). **The rename was
correct** — the ReAct loop moved into aptkit — but what's left
should be inlined into the two files that import it (`aptkit-adapters.ts`,
`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`) or merged
with `aptkit-adapters.ts` as a single `agents/base` module. The
14-line file is one grep step nobody needs to take.

**Runner-up shallow module.** `lib/agents/pricing.ts` — 61 LOC — is
borderline. It exports one function (`estimateAnthropicCost`) that
is short. But its purpose is genuinely narrow (fill the aptkit
gap for Anthropic pricing) and it's called from three sites
(`budget.ts`, `eval/run.eval.ts`, `eval/load.eval.ts`). This is
*narrow* not *shallow* — the interface is one function because the
job is one function. Keep as-is.

## 3. information-hiding-and-leakage

Facts that live in two modules and force them to change together.
Config that exposes internals. Temporal decomposition where every
step of a process gets its own file.

**Best-hidden decision.**
"Which vendor SDK is the Anthropic-shaped one" lives entirely
inside `lib/agents/aptkit-adapters.ts` (263 LOC). The three adapter
classes — `AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`,
`BloomingTraceSinkAdapter` — plus their private converter functions
(`toAnthropicMessage`, `toAnthropicTool`, `toModelContentBlock`, etc.)
sit in one file. Every one of `monitoring.ts` / `diagnostic.ts` /
`recommendation.ts` imports the three adapter classes as a bundle
and never sees the anthropic SDK or the aptkit type surface
directly. That fence is what lets the Bloomreach-side code type-check
without pulling `@anthropic-ai/sdk` types into every agent file.
Deep walk: `02-aptkit-bridge.md`.

**Leaked fact — same knowledge, edited in two places.**
The Anthropic model name `'claude-sonnet-4-6'` appears in five
files: `lib/agents/base.ts:5` (`AGENT_MODEL`), `lib/agents/budget.ts:47`
(the `BudgetTracker` constructor default), `eval/run.eval.ts:219`
(the `estimateCost` fallback in the diagnosis-cost branch),
`eval/run.eval.ts:273` (same, recommendation branch),
`eval/load.eval.ts:299` and `:302` (both cost estimates). If
you upgrade to a new Sonnet SKU, all five must move together.
**Fix: `BudgetTracker` and the eval cost-estimator should read
`AGENT_MODEL` from `base.ts`, not hardcode it.** The default in
`BudgetTracker`'s constructor is where the leak started — it names
the model to compute a cost, but the cost is about "whatever model
the agents actually run." Depend on the constant.

**Second leak — the `ToolResult` open shape.**
`lib/data-source/types.ts:32` — `ToolResult` declares `[key: string]:
unknown` on the interface to let `structuredContent` ride through
the seam without appearing in the type. This is the escape hatch
that makes `unwrap<T>(result)` in `lib/mcp/schema.ts` work. But the
interface doesn't say that — a reader has to trace to `unwrap()`
to learn why the type is open. **Fix: name `structuredContent` on
the `ToolResult` interface explicitly, as `structuredContent?:
unknown`, and drop the open index signature.** The one field that
actually rides through gets named; the type stops promising
anything to callers.

**Third leak — the `pricing.ts` regex list.**
`lib/agents/pricing.ts:26-33` — the Anthropic pricing table has
three model families. If Anthropic prices change or a new family
ships, both the table here and any hardcoded model in `base.ts`
must be edited. Not urgent, but the same knowledge (model
identity) is expressed as a regex here and a literal there.

## 4. layers-and-abstractions

Pass-through methods and pass-through variables. Layers that don't
earn their place — a call chain where a wrapper just forwards.

**Genuine pass-through: `RecommendationAgent.propose`.**
`lib/agents/recommendation.ts:26-46` — the class wraps `AptKitRecommendationAgent`
and its `propose()` method forwards to `agent.propose(anomaly,
diagnosis, { signal })`. The wrapper does five things: builds the
model adapter, builds the tool registry, builds the trace sink,
builds the aptkit agent, and calls its `propose`. The header
comment on line 16 names this honestly ("Compatibility wrapper:
Blooming keeps this constructor while AptKit owns the reusable
agent"). Same shape in `lib/agents/diagnostic.ts:37-63`.

**Is this a pass-through worth removing?** No — but recognize why.
The wrapper does one load-bearing job: it converts aptkit's
`DiagnosticDiagnosis` type back to Blooming's `Diagnosis` type
(`toBloomingDiagnosis` on line 65), which today happens to be an
identity function. The conversion function exists so that when
aptkit's shape drifts from ours, there's already a seam to
insert the mapping into. **This is speculative future-hardening**
by AOSD standards, which normally recommends against it — but in
this specific case the two adapters and the trace-sink bundle
argue that the API-shape drift is likely enough to justify the
seam. Live with it; annotate why.

**No pass-through variables.** The hooks bag (`AgentHooks`) is
threaded from route handler → agent method → adapter → trace sink,
but every layer *reads* from it (`hooks.budget`, `hooks.signal`,
`hooks.onCapabilityEvent`), so no field is a bare forward.

## 5. pull-complexity-downward

Knobs the module has enough information to decide itself but
pushes up to callers.

**Best example of complexity pulled down.** The NDJSON reader
(`lib/streaming/ndjson.ts` — 64 LOC). Three callers used to run
the same fetch → reader → TextDecoder → buffer → split('\n') →
JSON.parse → dispatch shape inline: `useBriefingStream.ts`,
`useDemoCapture.ts`, `useInvestigation.ts`. Every one had to know
about the trailing-buffer flush, the malformed-line skip, and the
cancel-between-reads polling. The kernel owns all three concerns
now; callers pass a `body` stream, an `onEvent` handler, and
optionally a `cancelOn` predicate. Deep walk: `06-ndjson-kernel.md`.

**Knob still exposed that could be owned.** `AnthropicModelProviderAdapter`
takes six constructor params: `anthropic, agent, sessionId, model,
logSite, budget`. Two of them (`model`, `logSite`) have defaults
that the two agent call sites always accept. The call sites
pass `undefined, undefined, hooks.budget` positionally
(`lib/agents/diagnostic.ts:52-54`, `lib/agents/recommendation.ts:36-38`).
**Fix: convert to a named-options object.** `new AnthropicModelProviderAdapter({
anthropic, agent, sessionId, budget: hooks.budget })` reads
straight. The two undefined positional args are a red flag by
themselves.

**One knob that's correctly pulled down.** `BudgetTracker`'s
`exceeded()` method reads the limits from the tracker itself; the
adapter (`aptkit-adapters.ts:64`) only asks "did you exceed?" and
throws if yes. The adapter never sees the limit values. The
tracker owns both accumulation and the ceiling check — the
adapter is a pass-through to the tracker, not the other way around.

## 6. errors-and-special-cases

Where exception handling is scattered across call sites, and
where a different definition would erase a class of special cases
altogether.

**Special case defined out.** `readNdjson` (`lib/streaming/ndjson.ts:52-60`)
handles the "producer forgot the trailing newline" case by
flushing the buffer at end-of-stream. Every caller *could* have
handled that itself, badly. The kernel absorbs it once and every
caller inherits the correct shape.

**Well-defined error class.** `BudgetExceededError`
(`lib/agents/budget.ts:85-95`) carries the snapshot and the limit
as fields, so the route handler can emit a graceful NDJSON `error`
event without reconstructing the state. The class documents its
own emission path in the constructor comment. This is the
right shape.

**Error handling that's still scattered — the fault injector.**
`FaultInjectingDataSource` fires four failure modes
(`fault-injecting.ts:112-155`): three throw, one returns a
malformed envelope. Each fire method is short but the shape isn't
uniform — a reader has to check whether each mode throws or
returns. **This is deliberate** — the whole point is that agents
handle both throw and malformed-envelope paths, and the injector
exercises both. But it's worth naming in the type: today, `roll <
threshold` returns `Promise<DataSourceCallResult>` from three of
the four branches by throwing, and one branch by returning. The
signature doesn't tell you that. **Fix (minor): document the
"three throw + one return" shape at the top of the file.**

**No scattered try/except.** The only two `catch` blocks in
`lib/` are in `ndjson.ts` (the malformed-line handler) and
`app/page.tsx` (the `localStorage.getItem` guard). Both are
one-line silent-swallow catches with a clear comment. This is
clean.

## 7. readability

Names, comments, consistency, obviousness. Four facets, ranked
list per facet.

### names

Strong. The port is `DataSource`, adapters end in `-DataSource`,
the aptkit bridge classes end in `-Adapter`, the trace sink is
`BloomingTraceSinkAdapter`. When names get long they get precise:
`AnthropicModelProviderAdapter` is nine syllables and reads exactly
what it does.

Worst names:
- `hooks` (`lib/agents/diagnostic.ts:46`, everywhere) — the AgentHooks
  bag is called `hooks`. This is fine until you realise there are
  React hooks in the same repo. **Fix: `agentHooks` at the call
  site, `hooks` inside the type is fine.**
- `McpCaller` (`lib/agents/base.ts`) — this is the client-facing
  type of the `DataSource` port's tool-call surface. The name says
  "an MCP caller" but the seam has been renamed to `DataSource`
  and this alias hasn't followed. **Fix: rename to `ToolCaller`
  or drop and use `DataSource` directly.**

### comments

Strong. Every load-bearing file (`types.ts`, `fault-injecting.ts`,
`budget.ts`, `pricing.ts`, `ndjson.ts`, `aptkit-adapters.ts`)
opens with a purpose comment that names what the file exists to
solve. `pricing.ts:1-14` is a good example — it says which gap
this fills, what the upstream shape is (`estimateCost` returns
undefined for anthropic), and what caveats matter (cache-tier
pricing not included).

Missing interface comment worth adding:
- `DataSource` itself (`types.ts:63`) has an inline JSDoc line but
  no comment explaining *when a caller would want to swap
  adapters* — the seam's story. The existing header says "Currently
  `BloomreachDataSource` is the only implementation — an Olist
  (SQL-backed) adapter previously lived behind this seam and was
  removed," which is history but not motivation. **Fix: add one
  paragraph on the interface itself: "Callers hold this type, not
  a concrete adapter. Adapters live in `bloomreach-data-source.ts`,
  `synthetic-data-source.ts`, `fault-injecting.ts` (decorator)."**

Comment that restates the code — not many. `app/page.tsx` has one
weak comment (`// re-runs the briefing fetch below` at :94) that
adds nothing. Cleanest interface-comment in the repo:
`aptkit-adapters.ts:76-88` on the cache-control decision.

### consistency

Two hooks-bag shapes coexist:
1. `MonitorHooks` (`lib/agents/monitoring.ts:66-71`) — 4 fields.
2. `AgentHooks` (`lib/agents/diagnostic.ts:16-35`) — 5 fields.

`AgentHooks` has `onCapabilityEvent` and `budget`; `MonitorHooks`
doesn't. `RecommendationAgent` imports `AgentHooks` from
`diagnostic.ts` rather than defining its own. **Fix: rename
`AgentHooks` to `InvestigationHooks` (since it's used by
diagnostic + recommendation) or fold `MonitorHooks` into `AgentHooks`.**
Two type names for the same job is the classic red flag.

Second consistency issue: five different filename shapes under
`lib/agents/`:
- `monitoring.ts` / `monitoring-legacy.ts` (no dashes vs one)
- `aptkit-adapters.ts` (dashes)
- `tool-schemas.ts` (dashes)
- `base.ts` / `base-legacy.ts`

The `-legacy` suffix is the problem — it reads as if legacy files
are first-class members of the module tree. **Fix: move them to
`lib/agents/_legacy/` or delete.**

### obviousness

The "huh?" spot: `AnthropicModelProviderAdapter` positional args.
Call site: `new AnthropicModelProviderAdapter(this.anthropic,
'diagnostic', this.sessionId, undefined, undefined, hooks.budget)`
(`diagnostic.ts:48-55`). Two `undefined`s in a row is the code
telling you the interface is wrong. Named options would erase
the surprise.

Second surprise: `hooks.budget` is optional (`AgentHooks.budget`
has `?:`), but when set, it's a *shared instance* across
`DiagnosticAgent.investigate` and `RecommendationAgent.propose`
in the same investigation. `eval/run.eval.ts:212,267` shares one
`budget` between two agent calls to accumulate the total. The
sharing isn't visible from the type — it's just that the caller
holds a reference. **Fix: name the shared-instance contract in the
type comment.**

## 8. red-flags-audit

Ousterhout's red flags as a review checklist, marked against this
repo. `fires` / `doesn't` / `N/A`, with location + one-line fix
where it fires. Sorted by severity.

| Red flag                       | Status  | Location + fix                                                                                   |
|:-------------------------------|:--------|:--------------------------------------------------------------------------------------------------|
| Shallow module (classitis)     | fires   | `lib/agents/base.ts` — 14 LOC, one constant + one type. Inline or merge into `aptkit-adapters.ts`. |
| Duplicated modules             | fires   | `lib/agents/*-legacy.ts` — 9 files, only 2 test imports remain. Delete 7; migrate the 2 tests.     |
| Information leakage            | fires   | `'claude-sonnet-4-6'` in 5 sites. Read `AGENT_MODEL` from `base.ts` in `budget.ts` + evals.        |
| Avoidable config exposed       | fires   | `AnthropicModelProviderAdapter` 6-positional-arg constructor. Convert to named options.            |
| Vague name                     | fires   | `McpCaller` (should be `ToolCaller` or drop); `hooks` at call sites (should be `agentHooks`).      |
| Two conventions for one job    | fires   | `MonitorHooks` (4 fields) vs `AgentHooks` (5 fields) — fold or rename.                             |
| Interface leakage              | fires   | `ToolResult.[key: string]: unknown` (`types.ts:32`) hides the `structuredContent` escape hatch.    |
| Comment restates code          | fires   | `app/page.tsx:94` — "re-runs the briefing fetch below". Delete.                                    |
| Pass-through method            | fires but justified | `RecommendationAgent.propose` (`recommendation.ts:26-46`) — kept as drift-buffer against aptkit shape changes. Annotate. |
| Special-case sprawl            | doesn't | Errors are defined-out (readNdjson buffer flush; `BudgetExceededError`).                          |
| Try/except everywhere          | doesn't | Two catches in `lib/`; both narrow and commented.                                                  |
| Untyped generic                | doesn't | `DataSource.result` is `unknown` by choice (unwrap at call site).                                  |
| Hidden control flow            | doesn't | Every async path threads `signal`; no orphaned promises.                                          |
| Same knowledge edited twice — dates | doesn't | No date/timestamp literals repeated across files.                                                 |
| Temporal decomposition         | doesn't | Files are organized by concept (agent / data-source / mcp), not by step of a process.             |
| Deep interface hides too little | doesn't | `DataSource` is 2 methods; adapters are 200+ LOC each. Depth ratio ~1:100.                        |

**Highest-severity fires, in order:** duplicated modules (legacy),
shallow `base.ts`, model-name leak, positional-arg constructor.
The first two are the highest-leverage cleanup in the repo —
delete-only work, no behavior change.
