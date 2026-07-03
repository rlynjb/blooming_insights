# 05 — Fixture-Anchored Schema Tests

**Industry name:** *golden file testing* / *characterization tests*
(borrowed from the specific case of *wire-format contract tests*
against captured real payloads).
**Type:** Industry-standard pattern.
**Determinism side:** DETERMINISTIC. The captured JSON files are
byte-for-byte reproducible; the parser is a pure function of them.

═════════════════════════════════════════════════
Zoom out — where this pattern sits
═════════════════════════════════════════════════

Every MCP tool returns a response in one of two envelope shapes:
`{ structuredContent: {...} }` (preferred) or `{ content: [{ type:
'text', text: '<json>' }] }` (fallback). The `parseWorkspaceSchema`
function has to handle both, plus the specific shape of each of six
bootstrap tools' payloads. There are only two options for testing
this: **make up JSON fixtures** or **capture real ones from the
server**. This repo does the second.

```
  Zoom out — captured payloads as the source of truth

  ┌─ Live Bloomreach MCP ──────────────────────────────────────┐
  │  get_event_schema returns { structuredContent: {           │
  │    events: [ ~28 event definitions ] }}                    │
  │  ...                                                        │
  └───────────────────────────┬────────────────────────────────┘
                              │  captured once, committed
                              ▼
  ┌─ test/fixtures/*.json (8 files) ───────────────────────────┐
  │  get_event_schema.json                                     │
  │  get_customer_property_schema.json                         │
  │  list_catalogs.json                                        │
  │  get_project_overview.json                                 │
  │  list_dashboards.json                                      │
  │  list_funnels.json                                         │
  │  list_segmentations.json                                   │
  │  get_customer_schema.json                                  │
  └───────────────────────────┬────────────────────────────────┘
                              │  loaded at test time
                              ▼
  ┌─ test/mcp/schema.test.ts (24 tests) ───────────────────────┐
  │  · unwrap(fixture) ── prefers structuredContent            │
  │  · parseWorkspaceSchema({ eventSchema: fixture, ... })     │
  │  · asserts events.length === 28 (real captured count)      │
  └────────────────────────────────────────────────────────────┘
```

The fixture files are what the real Bloomreach server returned on a
specific day. If the wire format ever shifts under us, the parser
tests fail and we know before production does.

═════════════════════════════════════════════════
Structure pass — layers · axes · seams
═════════════════════════════════════════════════

**Layers:**
- captured payloads (`test/fixtures/*.json`, on disk)
- fixture loader (`loadFixture(name)` — `readFileSync + JSON.parse`)
- parser under test (`unwrap`, `parseWorkspaceSchema` from
  `lib/mcp/schema.ts`)
- test assertions (specific counts, specific field names)

**Axis held constant — trust:** what does each layer trust?
- fixture layer: trusts the real server (was captured from live)
- loader layer: trusts the file to exist and be valid JSON
- parser layer: trusts the envelope shape (either `structuredContent`
  or `content[0].text`) and delegates to type-narrowing
- assertions: trust the parser's output shape

Trust flips at the parser boundary — everything below is "external
data we captured;" everything above is "our code with a stable
contract."

**Seam:** the file boundary (`test/fixtures/*.json` as literal
source-of-truth files). Committed to git so anyone can rerun.

═════════════════════════════════════════════════
How it works
═════════════════════════════════════════════════

#### Move 1 — the mental model

You've stored a large JSON response in a variable at the top of a
test file — same idea, but the JSON lives in its own file so it can
be a git-blameable artifact. If the wire format changes, you diff
the fixture instead of the test. The parser tests then just say
"loading this exact captured payload, does our parser produce the
shape we expect?"

```
  The captured-fixture pattern

  file on disk:                   loaded once at test time:
  test/fixtures/                   const fixture = JSON.parse(
    get_event_schema.json  ──────►   readFileSync(path, 'utf-8'))
    (real Bloomreach response,
     ~28 events, ~150KB)                    │
                                            ▼
                                 tests assert:
                                 · unwrap(fixture) has 'events'
                                 · parseWorkspaceSchema returns
                                   28 events (real count)
                                 · specific event types are present
                                   ('purchase', 'session_start', ...)
```

Kernel:
- **committed fixture files** — checked into git; anyone can rerun
- **byte-preserving loader** — `readFileSync(path, 'utf-8') |
  JSON.parse`. No transformation, no cleanup, no injection of test
  values
- **specific-count assertions** — `expect(schema.events.length).toBe(28)`
  not `expect(schema.events.length).toBeGreaterThan(0)`. The specific
  count is the pin that catches wire-format drift
- **fixture reused across tests** — the same
  `eventSchemaFixture` drives `unwrap` tests and the
  full-schema-parse tests. Loaded once at file scope

Drop the specific-count assertion → the test still passes on a
20-event day AND a 28-event day; wire format drift slips through.
Drop the byte-preservation → you're testing your test cleanup, not
the real payload.

#### Move 2 — the walkthrough

**Step 1 — the loader (file-scope, single-cost).**

Loaded once when the test file is imported; every test reuses the
same in-memory object:

```
  Location: test/mcp/schema.test.ts:6-15

  function loadFixture(name: string): unknown {
    const p = join(__dirname, '../fixtures', name);
    return JSON.parse(readFileSync(p, 'utf-8'));
  }

  const eventSchemaFixture = loadFixture('get_event_schema.json');
  const customerPropsFixture = loadFixture('get_customer_property_schema.json');
  const catalogsFixture = loadFixture('list_catalogs.json');
  const overviewFixture = loadFixture('get_project_overview.json');
```

Four fixtures, one line each. If the fixture file's missing, the
whole test file fails to import — which is exactly what you want
(no silent skip).

**Step 2 — the envelope-unwrap tests (contract 1).**

`unwrap` is the "which envelope shape?" resolver. It prefers
`structuredContent` and falls back to `JSON.parse(content[0].text)`
when the first is absent. Tests hit both branches, then hit the
real fixture:

```
  Location: test/mcp/schema.test.ts:21-56

  describe('unwrap', () => {
    it('returns structuredContent when present', () => {
      const result = {
        structuredContent: { data: [1, 2, 3] },
        content: [{ type: 'text', text: '{"data":[9]}' }],
      };
      expect(unwrap<{ data: number[] }>(result)).toEqual({ data: [1, 2, 3] });
    });

    it('falls back to JSON.parse(content[0].text) when structuredContent is absent', () => {
      const result = {
        content: [{ type: 'text', text: '{"hello":"world"}' }],
      };
      expect(unwrap<{ hello: string }>(result)).toEqual({ hello: 'world' });
    });

    // ...

    it('unwraps real event schema fixture via structuredContent', () => {
      const u = unwrap<{ events: unknown[] }>(eventSchemaFixture);
      expect(Array.isArray(u.events)).toBe(true);
      expect(u.events.length).toBeGreaterThan(0);
    });
  });
```

The synthetic tests establish the contract; the real-fixture test
proves the real payload takes the `structuredContent` branch. If
Bloomreach ever switched to the `content[0].text` shape, this last
assertion would fail even though the parser still handled both.

**Step 3 — the full-schema-parse tests (contract 2, the star).**

Feed all four fixtures into `parseWorkspaceSchema`, assert against
specific captured counts:

```
  Location: test/mcp/schema.test.ts:62-80

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
    // ...
  });
```

`schema.events.length === 28` is the load-bearing assertion. Change
the parser to accidentally filter out an event? Fails. Change
Bloomreach to return 27 events? Fails, and the fix is to update the
fixture (git blame: `git diff` the fixture, tell the change).

**Where synthetic fixtures beat captured ones — the enum boundaries.**

Synthetic fixtures still earn their place for enum boundaries. The
validator tests (`test/mcp/validate.test.ts:23-30`) hand-roll
minimal well-formed objects and then mutate one field at a time:

```
  Location: test/mcp/validate.test.ts:22-30

  describe('isAnomalyArray', () => {
    const good = [{
      metric: 'conversion_rate',
      scope: ['mobile'],
      change: { value: -18, direction: 'down', baseline: '7d' },
      severity: 'warning',
      evidence: []
    }];
    it('accepts a well-formed anomaly array', () => {
      expect(isAnomalyArray(good)).toBe(true);
    });
    it('rejects a bad severity', () => {
      expect(isAnomalyArray([{ ...good[0], severity: 'huge' }])).toBe(false);
    });
    it('rejects a bad direction', () => {
      expect(isAnomalyArray([{
        ...good[0],
        change: { value: 1, direction: 'sideways', baseline: '7d' }
      }])).toBe(false);
    });
  });
```

Real captured fixtures could never cover "bad severity" because the
server never returns one. **Synthetic for negative cases; captured
for positive cases.** The two techniques are complementary, not
alternatives.

#### Move 2 variant — the load-bearing skeleton

Kernel: **captured file + specific-count assertion.**

Drop the captured file → you're testing a fantasy of the wire
format.

Drop the specific-count assertion → wire drift passes silently.

Hardening: reuse the fixture across tests (single load cost),
combine with hand-rolled negative cases for enum boundaries.

#### Move 2.5 — current state vs future state

**Now:** 8 committed fixtures cover the six bootstrap tools plus
2 unused ones (`list_dashboards`, `list_funnels`,
`list_segmentations`, `get_customer_schema`). The unused ones are
loaded but not asserted on in schema tests — they're kept for
future coverage.

**Future:** as new MCP tools are wired into the routes,
capture-a-payload-and-commit stays the mechanism. The pattern
doesn't scale badly — the parser is one function, each new tool
adds one fixture and 2-3 assertions.

#### Move 3 — the principle

Don't invent the world your parser will meet. Capture the real
world on a specific day, commit it, and pin your assertions to the
specific values you captured. Wire format drift becomes a
git-blameable event: the fixture diff shows what changed, the test
failure shows how the parser reacted. Combine with hand-rolled
synthetic fixtures for the enum/error boundaries the real world
doesn't produce.

═════════════════════════════════════════════════
Primary diagram
═════════════════════════════════════════════════

The full flow — capture, commit, test.

```
  Fixture lifecycle — capture to test

  ┌─ (once) live Bloomreach MCP ────────────────────────────────┐
  │                                                              │
  │  agent-side capture script hits get_event_schema             │
  │        │                                                     │
  │        ▼                                                     │
  │  writes response to test/fixtures/get_event_schema.json      │
  │                                                              │
  └──────────────────────────────┬───────────────────────────────┘
                                 │  git commit
                                 │
  ┌─ repo (persisted) ───────────▼───────────────────────────────┐
  │  test/fixtures/                                              │
  │    get_event_schema.json          ~150 KB, 28 events         │
  │    get_customer_property_schema.json                         │
  │    list_catalogs.json                                        │
  │    get_project_overview.json                                 │
  │    (+ 4 more for future coverage)                            │
  └──────────────────────────────┬───────────────────────────────┘
                                 │  npm test
                                 │
  ┌─ test/mcp/schema.test.ts ────▼───────────────────────────────┐
  │  const eventSchemaFixture = loadFixture(...)  ← once, top    │
  │                                                              │
  │  it('events is non-empty (~28 events)', () => {              │
  │    expect(schema.events.length).toBe(28);                    │  ◄── pin
  │  });                                                          │
  │                                                              │
  │  it('customer_properties includes email', () => {             │
  │    expect(schema.customerProperties).toContain('email');     │  ◄── pin
  │  });                                                          │
  └──────────────────────────────────────────────────────────────┘
                                 │  wire format drift?
                                 │
                            ┌────▼─────┐
                            │  git diff │  ← shows exactly what
                            │  fixture  │    changed on the wire
                            └───────────┘
```

═════════════════════════════════════════════════
Elaborate
═════════════════════════════════════════════════

Captured-payload testing has a lot of names: golden file testing
(most common), characterization testing (Michael Feathers' term
from "Working Effectively with Legacy Code"), snapshot testing
(when the tool automates the "did the output change" step). This
repo does a light-touch version: fixtures are input-side captures
of real payloads, not output-side snapshots of parsed structures.

The technique's cost is fixture maintenance. When Bloomreach ships
a new event, the fixture might get out of sync with reality; a
production regression can then survive because the tests still
pass against the stale fixture. The mitigation is *aging* — a
fixture older than N months is a smell. This repo doesn't automate
that check; the fix would be a dated header in each JSON
comment-preamble or a script that flags fixtures older than the
last release.

Two related techniques the repo could adopt but hasn't:

- **Response snapshots** for the routes themselves — capture the
  full NDJSON stream from a happy-path request into a fixture, then
  assert against it byte-for-byte on rerun. Would catch stream-shape
  drift (a new event type getting added silently) at zero cost per
  test. The `demo-insights.json` file is the manual version of this;
  the integration tests could reach for it more.

- **Property-based testing** for the validators
  (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`) —
  a `fast-check` generator would produce arbitrary well-shaped and
  malformed inputs, catching a class of validator drift the current
  explicit cases don't. Would pair well with the captured-fixture
  discipline: fixtures for realism, generators for edge case density.

Cross-links:
- Pattern 06 (fail-safe decode) uses the same "specific
  captured-shape assertion" discipline but for the client-config
  wire format
- `study-system-design`'s schema-gated coverage pattern relies on
  `parseWorkspaceSchema` producing a stable, non-empty shape —
  which is what these fixture tests defend

═════════════════════════════════════════════════
Interview defense
═════════════════════════════════════════════════

**Q: How do you test a parser that reads a specific server's wire
format without hitting the server in the tests?**

Answer: Capture the server's real response once, commit it to
`test/fixtures/`, load it in the test, and assert on specific
captured values — not "greater than zero" but "exactly 28 events."
The fixture is a git-blameable artifact of what the server returned
on a specific day; a wire-format drift becomes a test failure with
the fixture diff as the exact diagnosis.

Anchor: `test/mcp/schema.test.ts:6-15` (the loader) and
`test/mcp/schema.test.ts:77-79` (the `.toBe(28)` pin).

Diagram sketch:

```
  live server → capture once → test/fixtures/*.json (committed)
                                        │
                                        ▼
                            loadFixture() in test
                                        │
                                        ▼
                      parseWorkspaceSchema(fixture)
                                        │
                                        ▼
                      expect(events.length).toBe(28)  ◄── pin
```

**Q: Won't the fixture get stale?**

Answer: Yes — that's the tradeoff. The fixture is a snapshot of the
server on the day of capture; if the server evolves, the fixture
diverges. The mitigations are (a) date the capture in a header
comment or a sibling manifest file so you can spot old ones, and (b)
combine with hand-rolled synthetic fixtures for the enum/error
boundaries the real server never returns. In this repo, the
positive cases are captured; the negative cases (bad severity, bad
direction) are hand-rolled in `test/mcp/validate.test.ts` — the two
techniques complement each other.

**Q: Why `.toBe(28)` instead of `.toBeGreaterThan(0)`?**

Answer: Because `.toBeGreaterThan(0)` passes on a 20-event day and a
28-event day; it doesn't defend against wire-format drift. The
specific count is the pin — it tells you the parser produced
*exactly* what it should. If the fixture changes (server shipped 3
new events), the test failure walks you to the fixture diff. If the
parser regresses (accidentally filters out `payment_failure`
events), the test failure walks you to the parser. Either way,
you're one `git blame` from the answer.

═════════════════════════════════════════════════
See also
═════════════════════════════════════════════════

- `02-scripted-mcp-caller-fake.md` — the fake's per-tool envelope
  shape mirrors what these fixtures capture
- `06-fail-safe-decode-contract-tests.md` — same "pin specific
  captured shape" discipline at the client-config seam
- `audit.md` lens 5 — the captured fixtures are how boundary
  coverage stays honest
- `study-system-design` — the schema-gated coverage pattern that
  depends on this parser working
