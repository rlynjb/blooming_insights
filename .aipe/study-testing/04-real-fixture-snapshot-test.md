# 04 — real-fixture snapshot test

*Industry term:* **fixture**-based test against captured **golden**
responses — Industry standard (contract testing variant)

## Zoom out, then zoom in

You've written `import users from './users.json'` and used it in a
test instead of generating fake user data inline. Same shape, with a
twist: the fixtures here are *real responses* captured from the live
Bloomreach MCP server, committed to the repo, and re-read on every
test run. The parser under test gets the actual production payload
shape, not a hand-built guess.

```
  Zoom out — where this lives

  ┌─ Bootstrap chain (lib/mcp/schema.ts) ───────────────────┐
  │  list_cloud_organizations → list_projects →             │
  │    get_event_schema → get_customer_property_schema →    │
  │    list_catalogs → get_project_overview                 │
  │                          │                               │
  │                          ▼                               │
  │  parseWorkspaceSchema({ eventSchema, customerProps,     │ ← we are here
  │                         catalogs, overview })            │
  │                          │                               │
  │                          ▼                               │
  │  WorkspaceSchema { projectId, events[], properties[],   │
  │                    catalogs[], totals, ... }            │
  └──────────────────────────┬───────────────────────────────┘
                             │
  ┌─ Used by ────────────────▼───────────────────────────┐
  │  schemaSummary(...) → fed into every agent's prompt   │
  │  coverageReport(...) → category gating               │
  │  monitoring scan, diagnostic, query                  │
  └──────────────────────────────────────────────────────┘
```

**Zoom in.** Six JSON files under `test/fixtures/` hold real captured
responses from a real Bloomreach project. `test/mcp/schema.test.ts`
loads them with `readFileSync` and runs them through the production
parser. The 24 tests in that file aren't checking "does the parser
match my mental model" — they're checking "does the parser handle the
actual shape the Bloomreach team ships." If the parser's understanding
drifts from reality, those tests fail. If Bloomreach changes their
response shape, the fixtures go stale and the failures point at the
new mismatch.

## Structure pass

**Layers — three levels the fixture stack works across:**
- outer: the captured shape on disk (`test/fixtures/*.json`)
- middle: the parser under test (`parseWorkspaceSchema`)
- inner: the asserted projection (`schema.events`, `schema.totals`,
  shape-checks per field)

**One axis held constant — *where does the truth about the response
shape live?***
- outer: in the file on disk (captured from production once)
- middle: in the parser's understanding of that shape
- inner: in the test's assertions about the parser's output

**The seam — where the axis flips:** at the parser. Above the parser,
truth is "what Bloomreach actually returned that day." Below the
parser, truth is "what the code believes about the response." The
test asserts those two truths still agree. The day they don't, the
suite tells you which one to fix — usually the parser, sometimes the
fixture.

## How it works

### Move 1 — the mental model

A **fixture** is test data that lives outside the test code. A
**snapshot** test compares an output against a pinned reference value.
This pattern combines both: the *input* is a fixture (captured real
data), the *output* is asserted against a pinned reference (the
shape your code is contracted to produce from that input). The shape
of the kernel is "read disk → run parser → assert shape."

```
  The fixture-driven test kernel

  ┌─ disk ─────────────────────┐
  │ test/fixtures/             │
  │   get_event_schema.json    │ ← real captured response from
  │   get_customer_*.json      │   the Bloomreach MCP server
  │   list_catalogs.json       │
  │   get_project_overview.json│
  └────────────┬───────────────┘
               │  readFileSync + JSON.parse
               ▼
  ┌─ test setup ───────────────┐
  │ const eventSchemaFixture   │
  │   = loadFixture('...')     │
  └────────────┬───────────────┘
               │
               ▼
  ┌─ parser under test ────────┐
  │ parseWorkspaceSchema({     │
  │   eventSchema: ...,        │
  │   customerProps: ...,      │
  │   catalogs: ...,           │
  │   overview: ...,           │
  │ })                         │
  └────────────┬───────────────┘
               │
               ▼
  ┌─ assertions ───────────────┐
  │ events.length === 28       │
  │ events[0].name === 'campaign'
  │ events[0].eventCount === 204917
  │ purchase.eventCount === 27046
  │ view_item.properties        │ ← pinned to real values
  │   .includes('product_id')   │   from the captured response
  │ ...24 assertions total      │
  └─────────────────────────────┘
```

The load-bearing part is the *real* in "real fixture." A hand-built
fixture proves "the parser handles the shape I imagined." A captured
fixture proves "the parser handles the shape that actually shipped."
The second proof is far stronger, but it costs more — you have to
capture, commit, and refresh.

### Move 2 — the step-by-step walkthrough

**Load the fixtures from disk.**
`test/mcp/schema.test.ts:6-15`:

```typescript
function loadFixture(name: string): unknown {
  const p = join(__dirname, '../fixtures', name);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

const eventSchemaFixture = loadFixture('get_event_schema.json');
const customerPropsFixture = loadFixture('get_customer_property_schema.json');
const catalogsFixture = loadFixture('list_catalogs.json');
const overviewFixture = loadFixture('get_project_overview.json');
```

Synchronous `readFileSync` at module load — fine for tests, would be
a sin in production. The fixtures are deliberately loaded once and
shared across the `describe` block; nothing mutates them.

**Run the real parser against them.** Lines 62-71:

```typescript
const schema = parseWorkspaceSchema({
  projectId: 'test-project-id',
  projectName: 'Test Project',
  eventSchema: eventSchemaFixture,            // ← captured Bloomreach response
  customerProps: customerPropsFixture,
  catalogs: catalogsFixture,
  overview: overviewFixture,
});
```

`parseWorkspaceSchema` is production code (`lib/mcp/schema.ts`). The
test gives it the same data shape the live route would, then asks
what came out. Note `projectId` and `projectName` are *not* in the
fixtures — they're inputs to the parser, not response fields, and
the test echoes them straight back to confirm the parser doesn't
mangle them either.

**Assert against pinned real values.** The 24 assertions in this file
fall into three groups:

```
  Three flavors of assertion against real fixtures

  shape claims              count claims                     content claims
  ───────────────           ────────────                    ───────────────
  events is array           events.length === 28            events[0].name
  events sorted by          purchase.eventCount === 27046     === 'campaign'
    eventCount desc         view_item.eventCount === 89717  view_item.properties
  every event has           customerProperties.length === 9   includes ('product_id',
    name + properties +     totalCustomers === 123162        'title', 'brand')
    eventCount              totalEvents === 1173252         customerProperties
  catalogs is array         oldestTimestamp === 1704073839    contains
                                                              ('email','first_name',
                                                              'last_name','phone')
```

The pinned counts and names are *exact*. The test would fail if
Bloomreach added one event to the captured project, removed a
property, or renamed a field. That's the bug-detection trade-off:
strict pins catch upstream change immediately, at the cost of needing
re-capture when the upstream legitimately moves.

**Cross-link to robustness tests.** Lines 170-297 add a second block,
`describe('parseWorkspaceSchema — robustness')`, that hand-builds
*minimal* inputs (empty events, missing `event_types_overview`,
missing `default_group.properties`, text-only `content[].text`
fallback). Those aren't fixture-based — they pin the parser's
defensive paths. The split is principled: real fixtures defend the
happy path; minimal inputs defend the degraded paths.

**Layers-and-hops — the test vs the live route:**

```
  Live route vs test — labelled hops, same parser

  LIVE ROUTE (production)                       TEST
  ─────────────────────                          ────
  ┌─ /api/briefing ─┐                          ┌─ schema.test.ts ─┐
  │  GET handler    │                          │  describe(...)    │
  └────────┬────────┘                          └────────┬──────────┘
           │ hop 1: connectMcp                          │ hop 1: readFileSync
           ▼                                            ▼
  ┌─ McpClient.callTool ─┐                      ┌─ fixtures/ JSON ──┐
  │  list_cloud_orgs     │                      │  4 captured files │
  │  list_projects       │                      └────────┬──────────┘
  │  get_event_schema    │                               │
  │  get_customer_*      │                               │
  │  list_catalogs       │                               │
  │  get_project_overview│                               │
  └────────┬─────────────┘                               │
           │ hop 2: 6 round-trips                        │ hop 2: pass directly
           ▼                                             ▼
       6 raw responses                            same raw responses
           │                                             │
           ▼ hop 3: parseWorkspaceSchema                 ▼ hop 3: SAME parser
  ┌─ WorkspaceSchema ────┐                      ┌─ WorkspaceSchema ────┐
  │  (used by route)     │                      │  (asserted on)        │
  └──────────────────────┘                      └───────────────────────┘
```

The parser is the *same code* in both columns. The fixtures stand in
for the Bloomreach round-trips. That's why this is a high-confidence
test even though there's no network call.

**Capture discipline.** The fixtures were captured by running a real
briefing against a real Bloomreach project (`wobbly-ukulele`) and
committing the responses. When Bloomreach ships a breaking change,
the test fails — that's the alarm. The repair: re-capture (the
`/api/mcp/capture` and `/api/mcp/capture-demo` routes exist for
exactly this) and update the asserted counts. The cost is real but
bounded — one re-capture per upstream change.

### Move 3 — the principle

**Test against the shape that will actually arrive, not the shape you
think will arrive.** Hand-built fixtures are evidence that the parser
handles the test author's imagination. Real captured fixtures are
evidence that the parser handles the production reality. The cost is
keeping the fixtures fresh; the payoff is catching upstream drift the
day you run the suite, not the day a customer complains. For an MCP
seam you don't control, the trade-off is worth it.

## Primary diagram

```
  The full pattern — capture once, run forever

  ┌─ One-time capture (real Bloomreach run) ─────────────────────────────┐
  │                                                                       │
  │  /api/mcp/capture-demo  ─►  hits real loomi MCP server                │
  │                          ─►  saves 6 responses to test/fixtures/      │
  │                          ─►  commit to git                            │
  │                                                                       │
  └──────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  (lives on disk now)
                                  ▼
  ┌─ Every test run ─────────────────────────────────────────────────────┐
  │                                                                       │
  │  test/fixtures/                                                       │
  │    get_event_schema.json          → eventSchemaFixture                │
  │    get_customer_property_*.json   → customerPropsFixture              │
  │    list_catalogs.json             → catalogsFixture                   │
  │    get_project_overview.json      → overviewFixture                   │
  │                                  │                                    │
  │                                  ▼                                    │
  │  parseWorkspaceSchema({ ... 4 fixtures ... })                         │
  │                                  │                                    │
  │                                  ▼                                    │
  │  24 assertions: shape · counts (28, 27046, 89717, 9, 123162, ...) ·   │
  │                  content (campaign, purchase, view_item, email, ...)  │
  │                                  │                                    │
  │              ┌───────────────────┴──────────────────┐                 │
  │              │                                      │                 │
  │              ▼                                      ▼                 │
  │      all pass: parser ↔                    one fails: parser drift    │
  │      fixture still in sync                 OR upstream changed shape  │
  │                                                                       │
  │                                              → re-capture if upstream │
  │                                              → fix parser if upstream │
  │                                                stable                 │
  │                                                                       │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is one shape of **contract testing** — pinning a parser's
behavior against an external system's actual output. The full
contract-testing tradition (Pact, etc.) builds machinery on top:
provider/consumer split, version negotiation, schema registries. For
a small repo with one upstream, hand-rolled fixture files give you
80% of the value at 5% of the setup cost.

The pattern has a sibling in this repo:
`test/data-source/synthetic-data-source.test.ts:36-52` pins the
envelope shape (`structuredContent.anomalies[0].category`,
`content[0].text`) of the SyntheticDataSource so its tool responses
look exactly like Bloomreach's. That's the *forward* version: instead
of capturing what came in, you assert what's going out. Combined, the
two pins the bidirectional contract — the parser handles what the
real server sends; the synthetic adapter sends what the parser
expects.

What this pattern *won't* defend against: an upstream change that
keeps the *shape* the same but changes the *semantics* — e.g.
Bloomreach starts returning event counts in millions instead of raw
counts. Every type-level assertion still passes; only a semantic
sanity check (revenue in expected order of magnitude) would catch it.
That's an eval-shaped problem (see `study-ai-engineering`), not a
unit-test problem.

The fixture refresh cadence is the operational discipline that keeps
the pattern honest. If fixtures go six months without re-capture, the
test is proving the parser still handles the *historical* shape — not
the current one. The repo doesn't have a pinned re-capture cadence
yet; that's a known soft spot.

## Interview defense

**Q: Why real captured fixtures instead of `zod` schemas + generated
test data?**

Two reasons. First, captured fixtures encode *what the real server
actually returns* — including the quirks the docs don't mention, the
fields that are sometimes-null, the encoding gotchas. A `zod` schema
encodes what the docs *say*; if the server drifts from the docs, the
schema-driven test doesn't notice. Second, the capture-and-commit
move costs one engineer-hour to set up; building a generator-based
test suite that approximates the real shape costs days. For a fast-
moving upstream the fixtures pay back the moment something breaks.

```
  Captured fixtures vs generated test data

  generated (zod + fast-check)        captured fixtures
  ──────────────────────────          ─────────────────
  proves: parser handles any         proves: parser handles
    shape matching the schema           the EXACT shape that
                                        the real server ships
  catches: schema-derived bugs       catches: real upstream
                                        drift, undocumented
                                        quirks, encoding gotchas
  refresh: schema definition         refresh: re-capture from
    (rare)                              live server (per breaking
                                        upstream change)
  cost:    high (build + maintain    cost:    low (one capture,
            generators, schemas)              commit, re-run)
```

**Q: Load-bearing part of this kernel — what breaks if missing?**

The pinned exact counts (`events.length === 28`,
`purchase.eventCount === 27046`). The shape assertions
(`every event has name + properties + eventCount`) catch parser-side
bugs. The count assertions catch upstream-side drift. Drop the
counts and a Bloomreach team's silent renaming of a field
(e.g. `event_count` → `total_count`) would parse to `0` everywhere and
every shape test would still pass — the test suite would tell you
nothing's wrong while the live UI shows "0 events" for every
metric. The exact-value pins are what make the upstream-drift signal
load through the suite.

**Q: What ISN'T this catching?**

The 5 untested API routes (`callback`, `reset`, `tools`, `capture`,
`capture-demo`). The fixtures were captured by `capture-demo`, but
the route that does the capturing has no automated test. If someone
breaks the capture path, the next person to refresh fixtures will
notice — but only when they try. That's a coverage gap, not a
fixture-pattern gap.

## See also

  → `02-mcp-as-callable-port.md` — the boundary the fixtures were
    captured *across*
  → `03-type-guard-as-runtime-validator.md` — the parallel defense at
    the agent ↔ JSON boundary
  → `audit.md` lens 1 — what-is-tested-and-what-isn't, which lists
    the routes still uncovered
