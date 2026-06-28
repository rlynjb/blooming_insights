# 02 — Fixture-driven schema parser tests
*Industry name: golden / recorded-response / characterization tests. Type: Industry standard.*

## Zoom out — where this pattern lives

```
  the contract test sits at the MCP envelope seam

  ┌─ Provider layer ─────────────────────────────────────────────────┐
  │  Bloomreach loomi-mcp-alpha (HTTP+SSE)                            │
  │  returns { content: [...], structuredContent: {...},              │
  │            isError?: bool }  ← THE ENVELOPE WE PIN                │
  └─────────────────────────────┬────────────────────────────────────┘
                                │   real responses captured to JSON
  ┌─ test/fixtures/ ────────────▼────────────────────────────────────┐
  │  get_event_schema.json         get_project_overview.json          │
  │  get_customer_property_schema.json   list_catalogs.json           │
  │  get_customer_schema.json      list_segmentations.json            │
  │  list_dashboards.json          list_funnels.json                  │
  │   ★ EIGHT FROZEN ENVELOPES — committed to git, replayed forever ★│
  └─────────────────────────────┬────────────────────────────────────┘
                                │   readFileSync + JSON.parse
  ┌─ test/mcp/schema.test.ts ───▼────────────────────────────────────┐
  │  24 it() — unwrap() and parseWorkspaceSchema() against the        │
  │  real shape, no mocks, no network                                 │
  └──────────────────────────────────────────────────────────────────┘
```

The parser (`lib/mcp/schema.ts`) consumes the envelope. The fixtures
**ARE** the envelope, captured from one real call to each MCP tool and
frozen on disk. The test reads them off the disk and runs them through
the parser. **The wire shape from a vendor we don't control is pinned
in a file we do control.**

## Structure pass — the skeleton this pattern hangs on

**Layers:** provider → captured fixture → parser → typed schema.

**Axis: trust — who's allowed to change the shape?**

```
  the trust boundary at the fixture file

  ┌─ provider ────┐  seam: the JSON file  ┌─ this codebase ───────┐
  │  Bloomreach   │ ═════════════════════ │  parser + tests own   │
  │  decides the  │  (frozen at capture   │  what they accept     │
  │  shape, when, │   time)               │                       │
  │  WE don't     │                       │  if the vendor drifts │
  └───────────────┘                       │  we detect on capture │
                                          │  not on prod          │
                                          └───────────────────────┘
```

The fixture file is the contract. The vendor controls the wire; we
control the file; the parser reads the file. If a real response
ever stops matching a fixture, **the test still passes** — what
fails is the next manual recapture, and that surfaces the drift to
a human reviewing a PR diff.

**The seam that matters:** the envelope shape itself. Two real
variants live in the wild — `structuredContent: {...}` (preferred)
or `content: [{ type: 'text', text: '...' }]` (fallback) — and the
parser handles both. The fixture suite includes both shapes (see
`schema.test.ts:21-43` for the synthetic-envelope variants and
`45-55` for the real-fixture variants).

## How it works

### Move 1 — the mental model

You know how database integration tests sometimes seed a SQLite db
from a `.sql` file and run real queries against it? Same idea, one
hop further out: instead of a captured database, **a captured network
response**. The parser doesn't know the response came from disk; it
just parses an object. The disk file lets the test reproduce a real
production response without the network.

```
  The pattern — a frozen envelope playing the provider's role

  ┌──────────────────────────────────┐
  │  test/fixtures/get_event_schema.json │
  │  { "content": [...],              │   ← real bytes captured ONCE
  │    "structuredContent": {          │      from loomi-mcp-alpha
  │      "events": [ {type, properties} ]} │
  │  }                                │
  └──────────────┬───────────────────┘
                 │  readFileSync(path)
                 │  + JSON.parse
                 ▼
  ┌──────────────────────────────────┐
  │  unwrap(fixture)                  │   ← parser logic under test:
  │    → prefers structuredContent     │      handles both envelope
  │    → falls back to content[0].text │      shapes
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │  parseWorkspaceSchema({           │
  │    eventSchema, customerProps,    │   ← business-shape mapper:
  │    catalogs, overview, ...        │      pulls fields out of the
  │  })                               │      raw envelope into a typed
  │  → WorkspaceSchema (typed)        │      WorkspaceSchema
  └──────────────────────────────────┘
                 │
                 ▼
            ASSERTIONS
            (~28 events, eventCount > 0,
             expected event names present,
             etc.)
```

The whole pipeline runs in memory. Speed: microseconds. Determinism:
total. Coverage of the real wire shape: 100% — because the fixture IS
the real wire shape.

### Move 2 — the step-by-step walkthrough

#### Step 1 — capture a real response, once

The fixtures don't get hand-written. They get captured by hitting the
real Bloomreach MCP server, logging the response, and saving the JSON
to `test/fixtures/`. The repo has a `scripts/` directory and dev-only
capture endpoints (`app/api/mcp/capture/`, `app/api/mcp/capture-demo/`)
that do exactly this for the live demo snapshot — the test fixtures
follow the same idea at a smaller scope.

What gets committed: one envelope per tool, representative of a
healthy live response. No PII (the fixtures are from the synthetic
test workspace).

#### Step 2 — load the fixture in the test file

```ts
// test/mcp/schema.test.ts:1-15
import { readFileSync } from 'fs';
import { join } from 'path';
import { unwrap, parseWorkspaceSchema } from '../../lib/mcp/schema';

// Load real captured fixtures from disk.
function loadFixture(name: string): unknown {
  const p = join(__dirname, '../fixtures', name);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

const eventSchemaFixture = loadFixture('get_event_schema.json');
const customerPropsFixture = loadFixture('get_customer_property_schema.json');
const catalogsFixture = loadFixture('list_catalogs.json');
const overviewFixture = loadFixture('get_project_overview.json');
```

Synchronous reads at module load. No `beforeAll`, no async fixture
helper — the JSON is on disk, the parser is pure, no setup is needed.

#### Step 3 — assert two things at two altitudes

The tests check the parser at two levels:

**Level A — the envelope unwrapper** (the lower-level seam):

```ts
// test/mcp/schema.test.ts:21-43
describe('unwrap', () => {
  it('returns structuredContent when present', () => {
    const result = {
      structuredContent: { data: [1, 2, 3] },
      content: [{ type: 'text', text: '{"data":[9]}' }],
    };
    expect(unwrap<{ data: number[] }>(result)).toEqual({ data: [1, 2, 3] });
  });

  it('falls back to JSON.parse(content[0].text) when structuredContent is absent', () => {
    const result = { content: [{ type: 'text', text: '{"hello":"world"}' }] };
    expect(unwrap<{ hello: string }>(result)).toEqual({ hello: 'world' });
  });

  it('unwraps real event schema fixture via structuredContent', () => {
    const u = unwrap<{ events: unknown[] }>(eventSchemaFixture);
    expect(Array.isArray(u.events)).toBe(true);
    expect(u.events.length).toBeGreaterThan(0);
  });
  // ... more
});
```

The synthetic envelopes (the first two) pin the **branch logic** —
prefer `structuredContent`, fall back to `content[0].text`. The real
fixture (the third) pins that the **actual wire** uses the
`structuredContent` branch and the array is non-empty. Two altitudes,
same parser, complete coverage of the unwrap contract.

**Level B — the full schema parser** (the higher-level mapper):

```ts
// test/mcp/schema.test.ts:62-80
describe('parseWorkspaceSchema — real fixtures', () => {
  const schema = parseWorkspaceSchema({
    projectId: 'test-project-id',
    projectName: 'Test Project',
    eventSchema: eventSchemaFixture,
    customerProps: customerPropsFixture,
    catalogs: catalogsFixture,
    overview: overviewFixture,
  });

  it('echoes projectId and projectName', () => {
    expect(schema.projectId).toBe('test-project-id');
    expect(schema.projectName).toBe('Test Project');
  });

  it('events is non-empty (~28 events)', () => {
    expect(schema.events.length).toBe(28);
  });
  // ... 22 more assertions on event shape, customer props, catalogs, overview
});
```

24 `it()` total. Each one pins a specific field of the parsed
`WorkspaceSchema` — exact event counts, expected event names,
customer-property keys, overview totals. **The numbers in the assertions
are facts about the captured fixture, not the parser** — which is what
makes the test stable across parser refactors but brittle if the
fixture is recaptured against a different workspace.

#### Step 4 — what happens when the vendor drifts

```
  fixture drift detection — what catches it, what doesn't

  scenario                               who notices, when
  ──────────────────────────────────     ────────────────────────────────
  Bloomreach adds a new event type       NOBODY, until you recapture the
   to the live workspace                  fixture (the test passes against
                                          the old fixture forever)
  Bloomreach renames a property in the   NOBODY in the test suite, BUT
   wire envelope                          the parser may start returning
                                          undefined for that field; a
                                          downstream test on
                                          parseWorkspaceSchema OUTPUT would
                                          catch it the next time the
                                          fixture is recaptured
  the parser is refactored               THE EXISTING TESTS — they pin
   incompatibly                           the exact output shape against
                                          the same fixture; a change in
                                          how unwrap branches or how
                                          parseWorkspaceSchema maps would
                                          flip an assertion
  the fixture file is corrupted/deleted  IMMEDIATELY — readFileSync throws
```

The discipline that matters: when you recapture, **diff the fixture in
the PR**. The diff is your contract diff. If Bloomreach added a field,
you'll see it in the JSON; you decide whether the parser should pick
it up.

#### Step 5 — why not use a recorded-HTTP library?

VCR / nock / msw with recorded responses do a similar job at a deeper
layer (the HTTP wire). The tradeoff:

```
                            HTTP-recorded       JSON-fixture (this repo)
                            (nock/msw)           ────────────────────────
  what's pinned             headers, status,    parsed envelope only
                            url shape too
  setup cost                wire up the         readFileSync + JSON.parse
                            mock server
  refactor blast radius     touches the         touches the parser only
                            transport layer
  what it catches           transport regress.  envelope regress.
                            + parser regress.
  what it doesn't catch     LLM output drift    LLM output drift
                                                + transport regress.
```

This repo's choice — JSON fixtures — is right for the parser tests
because the transport is tested separately (`test/mcp/transport.test.ts`,
15 `it()`) and the parser is the thing that's likely to refactor. The
transport pins the wire; the fixtures pin the envelope shape; the
parser is the only layer the schema tests actually exercise.

### Move 3 — the principle

**Frozen real data beats hand-rolled fakes for any parser.** Hand-rolled
fakes pin what the test author *thinks* the wire looks like. Captured
fixtures pin what it *actually* looks like. The cost is a one-time
capture and a recapture discipline; the benefit is that the test
exercises the same bytes a real user would generate.

The deeper principle: **the contract between two systems is a file
you can commit.** Once it's a file, it's diffable, reviewable, and
version-controlled. Once it's diffable, drift is detectable. Once
drift is detectable, the integration boundary stops being magic.

## Primary diagram — the whole pattern in one frame

```
  FIXTURE-DRIVEN SCHEMA PARSER TESTS — one frame

  ┌─ ONCE, manually ───────────────────────────────────────────────┐
  │  capture a real response from Bloomreach MCP →                  │
  │  save as test/fixtures/<tool_name>.json                         │
  │  commit the file; it's the contract                             │
  └──────────────────────────┬─────────────────────────────────────┘
                             │  (frozen for the life of the contract)
  ┌─ EVERY TEST RUN ─────────▼─────────────────────────────────────┐
  │                                                                  │
  │   loadFixture('get_event_schema.json')   ← readFileSync          │
  │             │                                                    │
  │             ▼                                                    │
  │   unwrap(fixture)                                                │
  │   ─ prefers structuredContent              ← branch A            │
  │   ─ falls back to content[0].text          ← branch B            │
  │             │                                                    │
  │             ▼                                                    │
  │   parseWorkspaceSchema({...})                                   │
  │   ─ events[]                                                    │
  │   ─ customerProperties[]              ← THE 24 it() ASSERT      │
  │   ─ catalogs[]                          THESE FIELDS HOLD       │
  │   ─ totalCustomers / totalEvents                                │
  │   ─ oldestTimestamp                                              │
  │             │                                                    │
  │             ▼                                                    │
  │   expect(schema.events.length).toBe(28)                          │
  │   expect(schema.events.map(e => e.name)).toContain('purchase')   │
  │   ...                                                            │
  └──────────────────────────────────────────────────────────────────┘

  Provider drift → fixture recapture → PR diff → human review
  Parser drift → existing assertions flip → CI red
```

## Elaborate

The technique has names depending on the community:

  → **Golden file testing** — Go community, mostly for compiler /
    formatter output, where the "fixture" is the expected output
    rather than the input.
  → **Snapshot testing** — Jest popularized this. The shape is similar
    (commit the expected output, compare on next run), but snapshots
    are typically auto-regenerated, which weakens the contract
    discipline.
  → **VCR / cassette testing** — Ruby + Python communities, for
    recording HTTP at the transport level. Heavier than this; pins
    the wire as well as the envelope.
  → **Characterization tests** (Feathers, *Working Effectively with
    Legacy Code*) — the broadest framing: capture current behavior
    as a contract, then refactor freely against it.

The variant in this repo is the **input fixture** flavor: the captured
file is the *input* to the parser under test, and the assertions name
specific fields of the *output*. The fixture is stable (real wire); the
assertions are precise (exact counts, exact names).

What makes this work for an LLM-integration codebase: the seam between
the agent and the data source is the *most likely* place for drift,
because the data source is a third-party API that evolves
independently. The fixture suite makes that drift surface in a code
review (the diff) rather than in production (the user complaint).

The closest pattern in the rest of this codebase: the `lib/state/demo-*.json`
snapshot files committed for the demo mode. Same shape — a real
trajectory captured to JSON, replayed deterministically. Not under
the `test/` directory but the discipline is identical.

## Interview defense

**Q: "Why commit real JSON envelopes instead of hand-writing minimal
test fixtures?"**

The hand-written version pins what I think the wire looks like. The
captured version pins what it actually does. The cost difference is
small (one capture step) and the bug-catching difference is large —
hand-written fixtures stay wrong until somebody runs production
through the parser.

I'd draw the trust boundary: Bloomreach owns the wire shape, but the
fixture file is in MY repo, in my PR-review process. The wire is a
moving target; the file is frozen until I update it. The update step
is a diff in a PR — that's the contract-review moment.

*anchor:* `test/mcp/schema.test.ts:1-15` for the load helper;
`test/fixtures/` for the eight committed JSON files.

**Q: "What's the load-bearing part people forget?"**

Two-altitude assertions. The unwrap tests run the parser against both
**synthetic envelopes** (hand-built, pin the branch logic — prefer
`structuredContent`, fall back to `content[0].text`) AND **real
fixtures** (pin that the real wire actually exercises the
`structuredContent` branch). Most fixture-test setups only do the
real-fixture half, which means a branch the wire doesn't currently
exercise can rot silently. Mixing synthetic + real at the same parser
function covers both.

*anchor:* `test/mcp/schema.test.ts:21-43` for the unwrap block — first
three `it()` are synthetic, fourth and fifth are real fixtures.

**Q: "How does this catch a vendor breaking change?"**

It doesn't catch it on the day the vendor breaks. The fixture file is
frozen — the test passes forever against the captured envelope. What
it catches is on the **next recapture**: when an engineer regenerates
the fixture before a PR, the diff shows the new shape. That's a
deliberate tradeoff — automated catching would require hitting the
real vendor in CI, which is slow + flaky + costs real money. The
recapture discipline shifts the catch-point from "production complaint"
to "PR diff," which is the largest leverage you can get without
network calls in CI.

The mitigation for the gap: a manual recapture step in the release
checklist, so the fixtures get refreshed at a known cadence rather
than only when someone happens to think of it.

## See also

  → `01-scripted-anthropic-harness.md` — same "fake at the interface,
    not the wire" discipline, applied to a different vendor.
  → `04-acceptance-with-per-gate-rejection.md` — what runs against
    the parser's *output* (the validated agent output) after the
    parser does its job.
  → `audit.md` lens 1 (risk map) — why schema parsing earns this
    much test investment; lens 2 (pyramid) — where these unit tests
    sit relative to the integration tier.
