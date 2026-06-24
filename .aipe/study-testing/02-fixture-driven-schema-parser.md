# 02 — Fixture-driven schema parser

**Industry name:** Captured-response fixture testing / golden-file testing. **Type:** Industry standard.

## Zoom out, then zoom in

The schema parser turns Bloomreach MCP's bootstrap responses into the `WorkspaceSchema` every agent reads. Those responses are *real, captured JSON* from a live MCP project — committed to `test/fixtures/` as eight `.json` files. The parser's 24 tests load these fixtures, run them through `parseWorkspaceSchema`, and assert on specific known values (`campaign` is the most-frequent event with 204917 hits; `purchase` is second with 27046). The fixture *is* the test contract.

```
Zoom out — where this pattern lives in the system

  ┌─ Agent layer (uses schema as input) ───────────────────┐
  │  DiagnosticAgent, RecommendationAgent, MonitoringAgent │
  │  read schema.events, schema.customerProperties, …      │
  └──────────────────────────┬─────────────────────────────┘
                             │ schema produced by
  ┌─ Bootstrap layer ────────▼─────────────────────────────┐
  │  lib/mcp/connect.ts → bootstrapSchema()                │
  │     calls 6 MCP tools, hands raw responses to parser   │
  └──────────────────────────┬─────────────────────────────┘
                             │
  ┌─ ★ PARSER (where this pattern lives) ★ ───────────────┐
  │  lib/mcp/schema.ts                                      │
  │     parseWorkspaceSchema({ eventSchema, customerProps, │  ← we are here
  │                            catalogs, overview })        │
  │  24 tests in test/mcp/schema.test.ts                   │
  │  driven by 8 captured fixtures in test/fixtures/       │
  └──────────────────────────┬─────────────────────────────┘
                             ▲ raw responses
  ┌─ External (captured once, replayed in tests) ─────────┐
  │  Bloomreach MCP: get_event_schema, …                   │
  └────────────────────────────────────────────────────────┘
```

Now zoom in. The interesting move is **how the fixture turns external reality into a test input** — and the boundary condition it carries: fixtures go stale.

## Structure pass

**Layers:** raw MCP response (JSON on disk) → parser input → parsed schema → assertion on schema values. **Axis traced:** *what's the source of truth for "is this parser right?"* **The seams where the answer flips:**

```
The axis "source of truth for correctness" — across the test stack

  axis traced = "what does the assertion compare against?"

  ┌─ pure-unit parser test ──────────────────────────────┐
  │  parseEventSchema({events: [{name: 'x', count: 1}]})  │  TEST AUTHOR
  │  → schema.events[0].name === 'x'                      │  is the source
  └──────────────────┬───────────────────────────────────┘    (made-up input)

  ┌─ ★ fixture-driven parser test ★ ─────────────────────┐
  │  parseWorkspaceSchema({                                │
  │    eventSchema: loadFixture('get_event_schema.json'), │  REAL MCP RESPONSE
  │    …                                                   │  is the source —
  │  })                                                    │  captured from a
  │  → schema.events[0].name === 'campaign'                │  real Bloomreach
  │  → schema.events[0].eventCount === 204917              │  project on a
  └──────────────────┬───────────────────────────────────┘    specific date

  ┌─ contract test (THE MISSING SEAM) ───────────────────┐
  │  fetch live MCP → diff shape against committed       │  LIVE SERVER is
  │  fixture → fail CI if shape drifted                  │  the source —
  └──────────────────────────────────────────────────────┘  catches schema drift
```

The middle band — fixture-driven — is what blooming insights does. It buys real-shape coverage; it does not buy drift detection. The third band would close that gap.

## How it works

### Move 1 — the mental model

A fixture-driven test moves the input from "test author's imagination" to "captured reality." You make one real call to the live external service, save the response to a file, commit it. From then on, every test reads the file and asserts on specific known values — the kind of values you can only know if you've *seen* the real response.

```
The fixture flow — capture once, replay forever

  ┌─ ONE-TIME CAPTURE (out of band) ─────────────────────┐
  │  call live MCP: get_event_schema(project_id)         │
  │  write response JSON to test/fixtures/<tool>.json    │  ← committed
  └──────────────────────┬───────────────────────────────┘
                         │
                         ▼ at test time
  ┌─ EVERY TEST RUN ─────────────────────────────────────┐
  │  const fixture = JSON.parse(readFileSync(path))       │
  │  const schema = parseWorkspaceSchema({                │
  │    eventSchema: fixture, …                            │
  │  })                                                   │
  │  expect(schema.events[0].name).toBe('campaign')       │  ← KNOWN VALUE
  │  expect(schema.events[0].eventCount).toBe(204917)     │  from the captured
  └──────────────────────────────────────────────────────┘    payload
```

The assertion `eventCount === 204917` is not arbitrary — it's the actual hit count of the most-frequent event in the captured project. A made-up test would say `expect(…).toBeGreaterThan(0)`; the fixture-driven test says `expect(…).toBe(204917)` because that's what the real response had.

### Move 2 — the walkthrough

#### The load function (one helper, used 8 times)

`loadFixture(name)` reads from `test/fixtures/`, parses JSON, returns the raw payload. One line of mechanics; eight fixture files.

```
The load helper — readFileSync + JSON.parse

  pseudocode:
    function loadFixture(name) {
      path = join(__dirname, '../fixtures', name)
      raw  = readFileSync(path, 'utf-8')
      return JSON.parse(raw)
    }

  fixture catalogue (all in test/fixtures/):
    get_event_schema.json              event taxonomy + counts
    get_customer_property_schema.json  customer attribute schema
    get_customer_schema.json           customer object shape
    get_project_overview.json          project metadata
    list_catalogs.json                 product catalog list
    list_dashboards.json               dashboard metadata
    list_funnels.json                  funnel metadata
    list_segmentations.json            segmentation metadata
```

All 8 fixtures are committed JSON. Tests are read-only against them; nothing rewrites the files.

#### Assertion on known-real values (the contract)

Once the fixture is loaded, the test asserts on values that could only be true if the parser correctly handled the real shape. Not "events is an array" — `events[0].name === 'campaign'` AND `events[0].eventCount === 204917`. That pins the parser against both the *shape* and the *sort order*.

```
The contract — specific values from the captured payload

  pseudocode:
    schema = parseWorkspaceSchema({
      eventSchema:   eventSchemaFixture,
      customerProps: customerPropsFixture,
      catalogs:      catalogsFixture,
      overview:      overviewFixture,
    })

    // pinned values from the real Bloomreach project:
    expect(schema.events.length).toBe(28)
    expect(schema.events[0].name).toBe('campaign')          // most-frequent
    expect(schema.events[0].eventCount).toBe(204917)
    expect(schema.events[1].name).toBe('purchase')          // second
    expect(schema.events[1].eventCount).toBe(27046)
    expect(schema.events[2].name).toBe('view_item')         // third
    expect(schema.events[2].eventCount).toBe(89717)
       │
       └─ if a refactor introduces a sort bug (sort by name instead of by
          count, or sort ascending instead of descending), the order
          changes and `events[0].name === 'campaign'` fails. The fixture
          IS the regression guard.
```

#### The robustness block (parser-level degeneracy)

Beyond the happy fixtures, the test file has a dedicated `describe('robustness')` block covering inputs the parser might see in production: empty `events` arrays, missing `event_types_overview`, missing `default_group.properties`, the text-only fallback when `structuredContent` is absent. Each robustness test constructs a *degenerate* fixture inline — not loaded from disk — and asserts the parser handles it without throwing.

```
The robustness block — degenerate inputs the parser must survive

  describe('robustness', () => {
    it('handles empty events', () => {
      const r = parseWorkspaceSchema({
        eventSchema:   { structuredContent: { events: [] } },
        customerProps: customerPropsFixture,
        catalogs:      catalogsFixture,
        overview:      overviewFixture,
      })
      expect(r.events).toEqual([])                   ← degenerate-valid
    })

    it('handles missing event_types_overview', () => { … })
    it('handles missing default_group.properties', () => { … })
    it('handles text-only fallback (no structuredContent)', () => { … })
  })
```

These are *unit* tests, not fixture tests — they exist because the fixture covers the happy shape, not the degenerate shapes. Both styles cohabit in the same file.

### Move 2 variant — the load-bearing skeleton

What is the irreducible kernel of fixture-driven testing?

1. **A captured real response, committed to the repo.** Drop this and you're back to "test author's imagination" — tests pass that wouldn't survive contact with real production data.

2. **At least one assertion on a specific value only true for THIS fixture.** "events is an array" passes for any input; `events[0].eventCount === 204917` only passes against the captured payload (or a payload that happens to match it exactly). Drop the specificity and the fixture loses most of its value — you might as well use a synthetic input.

3. **A separate degeneracy track for inputs the fixture doesn't cover.** Fixtures cover the happy shape; the parser must also survive `events: []`, missing fields, the no-`structuredContent` fallback. Drop this track and the parser is undertested on the edges.

Skeleton = captured fixture + value-specific assertion + degeneracy track. Drop the captured fixture and you have a made-up unit test; drop the specific assertion and you have decoration; drop the degeneracy track and you have a parser that breaks on empty inputs.

**The optional hardening that's NOT done here:** a CI job that re-fetches the fixture from the live MCP and diffs against the committed version. This is the contract-test layer — it would convert the silent "fixtures are stale" failure mode into a loud one. Today, if Bloomreach renames `events` to `event_definitions` tomorrow, every test still passes against the old captured payload and production breaks the first time a real call returns the new shape.

### Move 3 — the principle

**Fixture-driven testing is the strongest cheap test for an external boundary.** A handful of captured responses costs a one-time call to capture and gives you regression coverage forever — *as long as the external shape doesn't drift*. The pattern's blind spot is exactly that: drift. The fix isn't "stop using fixtures"; it's "add a contract test that runs against the live boundary to detect drift." Use both. The fixture pins behaviour fast and cheap; the contract test catches the day reality moves.

## Primary diagram

The full fixture-driven flow for the schema parser:

```
Fixture-driven schema parser — full pattern

  ┌─ ONE-TIME CAPTURE (manual, out of band) ────────────────────────┐
  │                                                                  │
  │  developer runs the app once, observes Bloomreach MCP traffic,  │
  │  captures the responses to test/fixtures/<tool>.json:            │
  │                                                                  │
  │    get_event_schema.json              event taxonomy + counts    │
  │    get_customer_property_schema.json  customer attribute schema  │
  │    get_customer_schema.json           customer object shape      │
  │    get_project_overview.json          project metadata           │
  │    list_catalogs.json                 product catalog list       │
  │    list_dashboards.json               dashboard metadata         │
  │    list_funnels.json                  funnel metadata            │
  │    list_segmentations.json            segmentation metadata      │
  │                                                                  │
  └─────────────────────────────┬───────────────────────────────────┘
                                │ committed to git
                                ▼
  ┌─ EVERY VITEST RUN (24 tests) ───────────────────────────────────┐
  │                                                                  │
  │   ┌─ load helper ─────────────────────────────────────┐          │
  │   │  loadFixture('get_event_schema.json')             │          │
  │   │   = JSON.parse(readFileSync(path, 'utf-8'))       │          │
  │   └────────────────────┬──────────────────────────────┘          │
  │                        │                                          │
  │                        ▼                                          │
  │   ┌─ parser under test ───────────────────────────────┐          │
  │   │  parseWorkspaceSchema({                            │          │
  │   │    eventSchema:   eventSchemaFixture,             │  ← REAL  │
  │   │    customerProps: customerPropsFixture,           │    DATA  │
  │   │    catalogs:      catalogsFixture,                │          │
  │   │    overview:      overviewFixture,                │          │
  │   │  })                                                │          │
  │   └────────────────────┬──────────────────────────────┘          │
  │                        │                                          │
  │                        ▼                                          │
  │   ┌─ assertions on KNOWN values ──────────────────────┐          │
  │   │  schema.events.length === 28                       │          │
  │   │  schema.events[0].name === 'campaign'              │  ← pins  │
  │   │  schema.events[0].eventCount === 204917            │    sort  │
  │   │  schema.events[1].name === 'purchase'              │    order │
  │   │  schema.events[2].name === 'view_item'             │          │
  │   └───────────────────────────────────────────────────┘          │
  │                                                                  │
  │   ┌─ separate `describe('robustness')` block ─────────┐          │
  │   │  inline degenerate inputs (empty events, missing   │          │
  │   │  event_types_overview, no structuredContent…)      │          │
  │   │  4 tests for boundary inputs the fixtures don't    │          │
  │   │  cover                                              │          │
  │   └───────────────────────────────────────────────────┘          │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘

  WHAT'S MISSING — the third band (contract test):

  ┌─ CI job — pull fresh fixture, diff against committed ───────────┐
  │  if shape differs → CI fails → re-capture fixtures, update      │
  │  parser if needed                                                │
  │  TODAY: not built; fixtures can silently go stale                │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case A — the load helper + the canonical assertion.** All 24 tests use the same `loadFixture` helper. The lines that pin the parser against captured reality are the specific value assertions.

```
test/mcp/schema.test.ts  (lines 5–16 — the load setup)

  function loadFixture(name: string): unknown {
    const p = join(__dirname, '../fixtures', name);
    return JSON.parse(readFileSync(p, 'utf-8'));     ← reads committed file
  }

  const eventSchemaFixture   = loadFixture('get_event_schema.json');
  const customerPropsFixture = loadFixture('get_customer_property_schema.json');
  const catalogsFixture      = loadFixture('list_catalogs.json');
  const overviewFixture      = loadFixture('get_project_overview.json');
       │
       └─ 4 of the 8 fixtures feed parseWorkspaceSchema; the other 4 feed
          monitoring + tool-coverage tests. Each fixture is committed JSON
          captured from a real Bloomreach project on a known date.

test/mcp/schema.test.ts  (lines 101–104 — the load-bearing assertion)

  it('first event (campaign, 204917) is the most active', () => {
    expect(schema.events[0].name).toBe('campaign');      ← real value, not invented
    expect(schema.events[0].eventCount).toBe(204917);    ← pins sort order
  });
       │
       └─ swap "campaign" for a different event tomorrow and the parser must
          still get the most-frequent-first ordering right; this is a
          regression guard against a sort bug introduced in a refactor.
```

**Use case B — the robustness block, covering inputs the fixtures don't.** The fixtures cover the happy shape (28 events, populated customer properties, full project overview). The robustness block constructs inline degenerate inputs the parser must also survive.

```
test/mcp/schema.test.ts  (lines 170–297 — the robustness block, abridged)

  describe('robustness', () => {
    it('handles an empty events array', () => {
      const r = parseWorkspaceSchema({
        eventSchema:   { structuredContent: { events: [] } },  ← inline degenerate
        customerProps: customerPropsFixture,                    ← real for the others
        catalogs:      catalogsFixture,
        overview:      overviewFixture,
      });
      expect(r.events).toEqual([]);                  ← parser survives empty
    });

    it('falls back to text content when no structuredContent', () => {
      const r = parseWorkspaceSchema({
        eventSchema:   { content: [{ type: 'text', text: '{"events": [...]}' }] },
        customerProps: customerPropsFixture,
        catalogs:      catalogsFixture,
        overview:      overviewFixture,
      });
      expect(r.events.length).toBeGreaterThan(0);    ← text-only path works
    });
       │
       └─ these inputs DON'T come from a fixture — they're inline because no
          captured payload happens to have an empty events array or a
          missing structuredContent envelope. The two styles cohabit:
          fixture-driven for the happy path, inline-constructed for the
          degenerates.
  });
```

## Elaborate

The "captured response as fixture" pattern is descended from "golden file" testing — store the expected output to a file, diff actual vs expected on every run. The variant here moves the capture to the *input* side: store the real upstream response, assert on the parser's output. Either way, the fixture is the contract.

This pattern's natural complement is **schema validation against the live source**. Bloomreach's MCP exposes a `listTools()` introspection method that returns the available tool schemas. `test/mcp/tool-coverage.test.ts` lines 70–82 already hardcodes the expected bootstrap tool names — graduate that to a live `listTools()` call and you have the contract test that closes the drift gap.

Cross-reference: `study-software-design`'s "the deep module is easy to test" — `parseWorkspaceSchema` is a single function with a small interface (one object in, one object out) and a lot of internal behaviour (unwrap structuredContent, handle text-only fallback, normalize event counts, sort by frequency, dedup customer properties). Deep modules invite fixture-driven tests because the surface to test is small and the behaviour to verify is rich.

## Interview defense

**Q: Why fixtures instead of synthetic inputs?** Because synthetic inputs reflect what the test author *thinks* the upstream returns, not what it *does* return. The Bloomreach MCP response shape has nested `structuredContent` envelopes, sometimes a `content[]` text-only fallback, an `event_types_overview` field that's optional, and counts that come back as JSON numbers but render as strings in some metadata responses. A synthetic input might miss any of these and the parser would still pass — until a real call hit a shape the test didn't model.

```
Synthetic vs fixture — what each guarantees

  synthetic input                          fixture input
  ───────────────                          ─────────────
  shape: whatever the author wrote         shape: whatever the real
                                            service returned
  coverage: only the cases the author       coverage: every quirk the
   imagined                                  capture saw
  cost: zero                                cost: one captured response
                                            per shape
  blind spot: the author's imagination      blind spot: the moment after
                                            capture (drift)
```

**Q: What's the failure mode you're accepting?** Fixture staleness. Today's fixtures were captured on 2026-05; if Bloomreach renames `events` to `event_definitions` tomorrow, all 24 tests still pass against the captured 2026-05 payloads while production breaks the first time a real call comes back with the new shape. The mitigation isn't to abandon fixtures; it's to add a CI job that fetches a fresh fixture from the live MCP and shape-diffs against the committed one. One afternoon of work. Not built today.

**Q: Why specific values like 204917 instead of "greater than zero"?** Because `eventCount > 0` passes for almost any input — a synthetic, a stale fixture, a malformed payload that happens to have one event. `eventCount === 204917` passes only when the parser correctly read the real captured payload's most-frequent event count and got the sort order right. The specific value pins both the parsing AND the post-processing (sort by frequency, take the top).

## See also

- `audit.md#what-is-tested-and-what-isnt` — the coverage map this pattern anchors
- `audit.md#testing-red-flags-audit` — flag 7 (no contract test on external) is the staleness gap this pattern carries
- `01-scripted-anthropic-harness.md` — the agent layer's complementary pattern; together they cover the lib boundary
- `04-acceptance-plus-per-gate-rejection.md` — the type-guard discipline applied to the parser's output, after parsing
