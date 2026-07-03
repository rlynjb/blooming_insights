# Captured-fixture schema tests

*Golden-file testing (recorded response) · Industry standard · Deterministic side*

Real MCP responses captured once from the live Bloomreach workspace,
committed to `test/fixtures/*.json`, and used as the input to
`parseWorkspaceSchema`. Tests assert on shape, count, order, and
individual field types. If Bloomreach changes its wire shape, the
fixtures don't match, and the parser tests catch it *before* the
production route does.

## Zoom out, then zoom in

```
  Zoom out — where captured fixtures live

  ┌─ Provider ──────────────────────────────────────────────────┐
  │ Bloomreach loomi connect MCP server                          │
  │ (returns JSON via the SDK's structuredContent envelope)      │
  └───────────────────────────┬──────────────────────────────────┘
                              │ captured ONCE
                              ▼
  ┌─ test/fixtures/*.json ──────────────────────────────────────┐
  │  get_customer_property_schema.json                           │
  │  get_customer_schema.json                                    │
  │  get_event_schema.json                                       │
  │  get_project_overview.json                                   │
  │  list_catalogs.json                                          │
  │  list_dashboards.json                                        │
  │  list_funnels.json                                           │
  │  list_segmentations.json                                     │
  └───────────────────────────┬──────────────────────────────────┘
                              │ readFileSync + JSON.parse
                              ▼
  ┌─ test/mcp/schema.test.ts ★ ─────────────────────────────────┐
  │  unwrap(eventSchemaFixture) → {events: [...]}                │
  │  parseWorkspaceSchema({eventSchema, customerProps, ...})     │
  │    → schema.events.length === 28                             │
  │    → schema.events sorted by eventCount desc                 │
  │    → every ev.name is a non-empty string                     │
  └──────────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers**: recorded upstream response → committed disk fixture →
  synchronous filesystem read in test → parser under test → assertion
  set.
- **Axis (trust)**: how much of the shape are we trusting the parser
  to preserve? A captured fixture is the "real" shape (from the vendor
  we don't control); the parser's job is to normalize it into our
  domain shape (`WorkspaceSchema`). The test pins both — the fixture's
  raw shape and the parser's output shape.
- **Seam**: `unwrap()` and `parseWorkspaceSchema()`. Both are pure
  functions; both take a captured payload and return a domain value.
  The seam sits between "vendor shape" and "domain shape".

## How it works

### Move 1 — the shape

You've probably heard "golden files" or "snapshot tests." Same idea,
different execution: the golden file here is a real response from a
real server, not a printout of the code's current output. That
distinction matters — a snapshot test pins whatever the code produces
today (a self-referential assertion). A captured-fixture test pins
what the vendor produced today (an external contract).

```
  Captured fixture — the shape of the assertion

  fixture on disk          test assertion
  ───────────────          ──────────────

  get_event_schema.json    parse(fixture) → schema
    ├─ structuredContent   assert schema.events.length === 28
    │   └─ events: [...]   assert schema.events[0].eventCount ≥
    │       28 items                     schema.events[1].eventCount
    │                      assert every event.name is a string
    ├─ content: [...]      assert schema.events uniq'd on name
    │                      etc.
    └─ ...                 the FIXTURE is the input; the PARSER is
                           the code under test.
```

### Move 2 — the moving parts

**Load once at module scope.** From `test/mcp/schema.test.ts:6-15`:

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

Module-scope reads are fine because the fixtures never change during
a test run. `readFileSync` is deliberate — `readFile` (async) would
force the fixtures into a `beforeAll`, adding ceremony for no gain.

**Test the envelope handling separately from the parse.** From
`test/mcp/schema.test.ts:22-55`, `unwrap<T>()` is tested against
in-line fixtures for the two paths (`structuredContent` present /
absent) AND against a real fixture:

```typescript
it('returns structuredContent when present', () => {
  const result = {
    structuredContent: { data: [1, 2, 3] },
    content: [{ type: 'text', text: '{"data":[9]}' }],
  };
  expect(unwrap<{ data: number[] }>(result)).toEqual({ data: [1, 2, 3] });
});

// ...

it('unwraps real event schema fixture via structuredContent', () => {
  const u = unwrap<{ events: unknown[] }>(eventSchemaFixture);
  expect(Array.isArray(u.events)).toBe(true);
  expect(u.events.length).toBeGreaterThan(0);
});
```

The first three tests pin the branch behavior with hand-built inputs
(clearer for the reader). The fourth pins the real-world case with
the actual fixture. Both matter — the branch tests catch a code
regression in `unwrap` itself; the fixture test catches a case where
Bloomreach silently switches from `structuredContent` to
`content[0].text`.

**Parse the whole schema and assert on structure.** From
`schema.test.ts:62-100+`:

```typescript
const schema = parseWorkspaceSchema({
  projectId: 'test-project-id',
  projectName: 'Test Project',
  eventSchema: eventSchemaFixture,
  customerProps: customerPropsFixture,
  catalogs: catalogsFixture,
  overview: overviewFixture,
});

it('events is non-empty (~28 events)', () => {
  expect(schema.events.length).toBe(28);
});

it('each event has name (string), properties (string[]), eventCount (number)', () => {
  for (const ev of schema.events) {
    expect(typeof ev.name).toBe('string');
    expect(ev.name.length).toBeGreaterThan(0);
    expect(Array.isArray(ev.properties)).toBe(true);
    for (const p of ev.properties) {
      expect(typeof p).toBe('string');
    }
    expect(typeof ev.eventCount).toBe('number');
  }
});

it('events are sorted by eventCount descending', () => {
  for (let i = 0; i < schema.events.length - 1; i++) {
    expect(schema.events[i].eventCount).toBeGreaterThanOrEqual(
      schema.events[i + 1].eventCount,
    );
  }
});
```

The event count (28) is *specific*. If Bloomreach's fixture gains a
29th event or drops to 27, this test fails. That's the pin — not
"more than zero" or "some events" but the exact number the recorded
snapshot has. When you re-capture, you update the count. Deliberate
re-capture is the whole workflow.

**Ordering is asserted independently of value.** The sorted-by-count
assertion loops the whole array — catches a bug where the sort was
broken by a change to the comparator without changing the fixture.

### Move 3 — the principle

**A captured fixture is an executable schema contract with an external
system.** You don't own Bloomreach; they can change their wire shape
whenever they want. The fixture is your record of what you designed
against. When they change, your fixture stops matching, your tests
fail, and you know *before* the change hits production. Without the
fixture, the code under test is defined by whatever Bloomreach
returned the last time you thought about it.

Industry names: **golden-file testing** (Google's term), **recorded
response**, **characterization test** (when applied to existing code
whose behavior you're pinning before refactoring). The distinguishing
trait is that the input is a *sample from reality*, not a synthetic
construction.

## Primary diagram

```
  Captured fixture — full round trip

  time = capture time                 time = every test run
  ──────────────────                  ──────────────────────

  Bloomreach MCP server              test/mcp/schema.test.ts
  ┌──────────────────┐               ┌──────────────────────┐
  │ get_event_schema │               │ loadFixture(          │
  │  → {events:[…]}  │               │   'get_event_schema.  │
  └────────┬─────────┘               │    json')             │
           │                          │ → eventSchemaFixture │
           │ ONCE                     └──────────┬───────────┘
           ▼                                     │
  scripts/capture-mcp-fixtures.ts               │
  writeFileSync('test/fixtures/                  │
    get_event_schema.json', json)                │
  ─── COMMIT ─────────────────────►             │
                                                 ▼
  git repo ──────────────────────► test/fixtures/get_event_schema.json
                                                 │
                                    ┌────────────┴──────────────┐
                                    │ unwrap(fixture)            │
                                    │  → {events: [...]}         │
                                    │ parseWorkspaceSchema({...  │
                                    │    eventSchema: fixture})  │
                                    │  → schema                   │
                                    │                             │
                                    │ assert schema.events.length │
                                    │   === 28                    │
                                    │ assert sorted desc          │
                                    │ assert every ev.name string │
                                    └─────────────────────────────┘
```

## Elaborate

The eight fixture files under `test/fixtures/` cover the whole
bootstrap path plus a few discovery endpoints:

- `list_cloud_organizations` (implicit — no fixture yet, tests use inline
  mocks in the integration files)
- `list_projects` (same)
- `get_event_schema` — largest fixture, drives most of the schema tests
- `get_customer_property_schema`
- `list_catalogs`
- `get_project_overview`
- `list_dashboards`, `list_funnels`, `list_segmentations` — discovery
  endpoints, used to verify tool-coverage reporting

The `test/api/mcp-call-allowlist.test.ts` file is a related-but-distinct
pattern: it's a **contract pin** on the route boundary. The comment
at the top calls it that explicitly:

> Contract pin tests for the /api/mcp/call allowlist guard. These
> don't assert the happy-path call shape; they pin the boundary:
> - an allowlisted name reaches conn.mcp.callTool (no 403)
> - an unsanctioned name (e.g. 'whoami', historically valid, now removed)
>   returns 403 with { error: 'tool not allowed' }

Same shape as a fixture test in that both pin an external contract
(the caller-side contract, in the allowlist case), but the fixture is
a JSON file; the contract pin is a set of assertions.

The tension in captured-fixture tests: **when do you re-capture?**
The workflow is manual — someone runs a capture script (there's a
`scripts/capture-mcp-fixtures.ts` in the repo) and commits the
updated JSON. If nobody re-captures for six months and Bloomreach's
event schema has slowly drifted, you'll find out when a fixture
test fails against a change that isn't actually a regression. The
fix is discipline (re-capture on a schedule or on a known upstream
change), not a code change.

## Interview defense

**Q: Why not generate the fixtures at test time from the live server?**

A: Three reasons. First, **cost**: hitting the live server on every
test run means an OAuth flow, rate limits, and network flakiness — the
221 tests would take minutes instead of seconds. Second,
**reproducibility**: if the vendor's data changes between runs (a new
purchase event lands), the test's assertions on event counts drift
and you can't tell if the code changed or the world did. Third,
**offline development**: the fixtures let you work on the parser on
a plane. Live-generated fixtures would break every one of those.

**Q: What's the failure mode of a captured fixture?**

A: **Staleness.** If nobody re-captures for a year and Bloomreach adds
a field to `event_schema`, your parser might silently drop it because
the fixture never had it. You wouldn't know until a production request
came back with the new field and the parser rejected it or ignored
it. The mitigation is deliberate re-capture (there's a script for
it), and — a next-level move — a separate low-frequency canary test
that hits the live server *just to compare shapes*, not to assert on
values.

**Q: What's the difference between this and a snapshot test?**

A: A snapshot test captures whatever the code produced last run and
asserts equality next run. It's self-referential — the code defines
the assertion. A captured-fixture test uses external data (from a
vendor, a database, a real user submission) as input and asserts on
what the code should do *with* that input. The fixture is an
external anchor; the snapshot is an internal one. Both have their
uses. This repo uses fixtures at the MCP boundary specifically
because that boundary crosses a system we don't own.

**Q: The event count is hardcoded to 28. What if Bloomreach adds an
event?**

A: The test fails. You look at the failure, decide whether it's a
real schema change (re-capture, update the count, commit both) or
a code regression that mis-parsed one of the existing events (fix
the code). The forcing function is the exact point of the test — a
loose `> 20` assertion would pass on either, which is the smell you
want to avoid.

## See also

- `02-injected-datasource-fake.md` — `SyntheticDataSource.listTools()`
  is verified against the same Bloomreach shape these fixtures
  captured. Same contract, different assertion mechanism.
- `audit.md` lens 1 — where fixture tests sit in coverage.
- `audit.md` lens 4 — why fixtures are a determinism *win*, not a
  flake source.
