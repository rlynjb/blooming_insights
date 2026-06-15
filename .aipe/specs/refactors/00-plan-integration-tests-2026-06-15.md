# Integration tests plan — `/api/briefing` + `/api/agent` (Precondition B)

> The route-level integration test scaffold that unblocks the 3 deferred
> frontend hook extractions (`useBriefingStream`, `useReconnectPolicy`,
> `useDemoCapture`). These hooks cannot claim "behaviour-preserving" against
> tests that don't yet exist — this plan writes those tests.

**Source:** `.aipe/audits/cleanup-2026-06-14T19-50-14.md` fix-later #11; cross-linked in `.aipe/audits/design-2026-06-14.md` Lens 2.1 as the precondition that defers `design-frontend-extract-use*.md` stub emission.
**Triage shape:** **NOT a refactor** — this is new test-writing work. Behaviour-preserving discipline does not apply; the goal is to add coverage that doesn't exist today. Tests 199 → ~215 (16 new tests across both routes).
**Estimated cost:** ~1 day (4 hours scaffolding + 4 hours test cases).

---

## Goal

Verify the **observable contract** of `/api/briefing` and `/api/agent` end-to-end (route entry → handler → NDJSON stream out) so that future refactors of those routes' consumers (the 3 page.tsx hooks) can claim behaviour-preservation against a real harness.

The current 199-test suite covers units in isolation (NDJSON parser, transport, redaction, mappers, agents, allowlist). It does **not** cover the route handlers themselves end-to-end. That gap is precondition B.

---

## What this unblocks

After this plan lands, the next `/aipe:audit-software-design` run will emit:

```
□ design-frontend-extract-usebriefingstream.md        (~150 LOC absorbed)
□ design-frontend-extract-usereconnectpolicy.md       (~30 LOC absorbed)
□ design-frontend-extract-usedemocapture.md           (~80 LOC absorbed)
```

Each of those hooks will be a `/aipe:refactor-frontend-behaviour` session against the integration test scaffold this plan establishes.

---

## Files (3 new)

```
test/api/
  _helpers.ts                      mocks + NDJSON consumer + auth stub
  briefing.integration.test.ts     7 tests
  agent.integration.test.ts        9 tests
```

No changes to `vitest.config.ts` — Node-style route handler tests run under the existing config. The `@` alias resolver added during cleanup #4 already supports route imports.

---

## Architecture — 4 mocking surfaces

The route handlers depend on 4 external surfaces. Each gets a deterministic mock in `_helpers.ts`:

### 1. Anthropic SDK (`@anthropic-ai/sdk`)

Mock pattern (vitest):
```ts
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: scripted }
  }))
}));
```

`scripted` returns from a `next()`-style queue of canned `MessageCreateResponse` objects (with `content`, `stop_reason`, `usage`). Each test pushes the response sequence it expects the agent loop to consume.

### 2. MCP transport (`lib/mcp/transport.ts`)

The existing `test/mcp/transport.test.ts` already shows the pattern: mock `SdkTransport.callTool` / `listTools` and assert payloads. Lift those patterns into `_helpers.ts` as `makeMockTransport(scenario)` returning either:
- `'ok'` — happy path with `listTools` returning the 4 allowlists, `callTool` returning scripted analytics responses
- `'list-tools-fail'` — throws on `listTools`
- `'tool-call-fail'` — throws on a specific `callTool` invocation
- `'timeout'` — never resolves (verifies the 30s timeout from cleanup #5 fires)

### 3. Session / auth (`lib/mcp/session.ts`, encrypted-cookie chain)

Stub `getOrCreateSessionId` to return a deterministic `'test-session-<n>'` so test assertions can match on the `sessionId` field in log lines (added by cleanup #2 and exercised by the synthesize lift). Stub the encrypted-cookie chain to:
- `'authed'` — returns valid session immediately
- `'unauthed'` — returns null (forces 401)
- `'expired'` — returns null with a `revoked` flag (forces the reconnect path the `useReconnectPolicy` hook handles)

### 4. NDJSON consumer

The route returns `ReadableStream<Uint8Array>` with `\n`-terminated JSON events. Tests need to **parse the stream into typed events** to assert event order + content. Reuse the just-extracted `readNdjson` kernel from `lib/streaming/ndjson.ts` (commit `0f06eff`) — it's already production-tested and handles the trailing-flush + split-across-reads cases.

```ts
async function collectEvents<E>(response: Response): Promise<E[]> {
  const events: E[] = [];
  await readNdjson<E>(response.body!, (e) => events.push(e));
  return events;
}
```

One helper, ~5 LOC. Pinned by the 5 readNdjson tests already in `test/streaming/ndjson.test.ts`.

---

## Test inventory — 16 tests

### `/api/briefing` (7 tests)

```
1. happy path — emits workspace_meta → coverage_report → reasoning_step ×N
                → tool_call_start/end ×N → insight ×N → done, in order
2. mode=demo  — uses cached snapshot; no live MCP calls; events identical shape
3. 401 path   — returns 401 without consuming any stream events (auth=unauthed)
4. listTools fail — emits error event with status; phase log fires with
                    schema_bootstrap or list_tools as the failing phase
5. monitoring scan fail — emits error event mid-stream; partial events still
                          flushed; phase log captures monitoring_scan timing
6. cancellation — client aborts mid-stream; route cleans up the reader
                  (cancel-on-poll from readNdjson kernel)
7. phase timing log — verifies the summary console.log fires with
                       { route, sessionId, totalMs, phases } shape; phases
                       array contains schema_bootstrap, coverage_gate,
                       list_tools, monitoring_scan
```

### `/api/agent` (9 tests)

```
1. diagnose step happy path — sequential pipeline emits investigation events;
                              parsed Diagnosis lands in final event
2. recommend step happy path — same shape with Recommendations[] terminal
3. query step happy path     — intent_classify fires; query_answer fires;
                                prose text in terminal event
4. recovery fires on null parse — diagnostic agent's parseResult returns null
                                   on first turn; runRecoveryTurn fires; second
                                   parse succeeds; investigation completes
                                   (tests the synthesize lift from cleanup #4)
5. recovery returns null too — both parse attempts fail; FALLBACK diagnosis
                                returned; route still emits done
6. 401 path                  — auth=unauthed; same shape as briefing #3
7. anomaly not found         — ?insightId points at unknown id; 404 with
                                { error: 'anomaly not found' }
8. sessionId in usage logs   — verifies log lines from base.ts:103
                                (runAgentLoop) and base.ts:N (runRecoveryTurn)
                                both carry sessionId=test-session-<n>
9. phase timing log          — phases array contains schema_bootstrap,
                                list_tools, + flow-specific entries
                                (intent_classify+query_answer OR
                                 diagnostic_investigate +/- recommendation_propose)
```

---

## Execution sequence

```
Phase 1 — scaffolding (~4 hours)
  □ Create test/api/_helpers.ts with 4 mock factories + collectEvents helper
  □ Write ONE smoke test in briefing.integration.test.ts that proves the
    scaffolding works: mock anthropic + mock transport + auth=authed →
    expect 200 + at least one workspace_meta event
  □ Run; verify it works; commit

Phase 2 — briefing tests (~2 hours)
  □ Add the remaining 6 briefing test cases
  □ Each test pushes the scripted response sequence it expects
  □ Run; verify 199 → 206 (+7 briefing tests); commit

Phase 3 — agent tests (~2 hours)
  □ Add the 9 agent test cases
  □ Reuse helpers; only the response sequences differ
  □ Run; verify 206 → 215 (+9 agent tests); commit

Phase 4 — verify unblock (~30 min)
  □ Run /aipe:audit-software-design after the PR merges
  □ Confirm it emits the 3 design-frontend-extract-use*.md stubs
  □ If it does — the 3 page.tsx hook extractions are now contracted
  □ If it doesn't — the audit's "documented-only" framing was wrong; revisit
```

**Three commits, one branch, one PR.** Same shape as the prior cleanup branches.

---

## Per-test contract

For each test:

1. **Arrange** — push scripted Anthropic + MCP responses; set auth stub mode
2. **Act** — call the route handler with a `Request` object; await response
3. **Assert** — for success cases: parse NDJSON events via `collectEvents`,
   assert event order + content. For error cases: assert status + error body.
   For log-line cases: spy on `console.log` and assert the JSON shape.

No tests assert against the live Anthropic API or the live Bloomreach MCP. Every dependency is mocked. The tests must run in `npm test` with no network access.

---

## Done when

```
□ test/api/_helpers.ts exists with the 4 mock factories + collectEvents
□ test/api/briefing.integration.test.ts has 7 passing tests
□ test/api/agent.integration.test.ts has 9 passing tests
□ npm test reports 215 passed (199 baseline + 16 new)
□ npx tsc --noEmit is clean
□ No new dependencies in package.json
□ The 3 deferred frontend-extract stubs become emittable on next audit run
```

---

## Hard rules

These are the discipline gates that prevent integration tests from becoming a tar pit:

```
→ No live network calls. Every dependency mocked.
→ No new dependencies. msw, supertest, etc. are out — vitest's vi.mock is
  enough for route handler tests in Next.js App Router (the route is
  just an async function returning a Response).
→ No more than 16 tests in this batch. If a 17th test is "while I'm here,"
  it goes to a follow-up stub.
→ Tests pin REALITY, not assumed behavior. Run the actual route handler
  first; assert what it emits. Don't write the test from the audit's
  description of what SHOULD happen.
→ Use the existing readNdjson kernel for stream parsing. Don't write a
  new parser. The kernel is the contract.
```

---

## What this plan does NOT cover

```
✗ Live integration tests against Bloomreach     out of scope; needs CI secrets
✗ Page.tsx hook tests                            those come AFTER this lands
✗ End-to-end browser tests (Playwright etc.)     separate testing layer; not
                                                  required by precondition B
✗ Performance / load testing                      not what the precondition asks
✗ The 3 frontend hook extractions themselves     unblocked by this plan, not
                                                  executed by it
```

---

## TL;DR

```
This plan:              16 integration tests across 2 route files + 1 helper
Estimated cost:         ~1 day, 3 commits, one PR
Tests:                  199 → 215
Unblocks:               3 design-frontend-extract-use*.md stubs (next audit run)
Not in scope:           live network, hook tests, performance, the hook extractions
```

Branch for execution: `test/route-integration` off main.
