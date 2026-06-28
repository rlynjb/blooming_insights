# Study — Debugging & Observability

How **this repo** reveals its own behavior. Three observability surfaces are live; the rest of the lens inventory either piggybacks on those or is honestly `not yet exercised`.

The product itself is observability. The agents' reasoning streams to the UI as a first-class surface — the user watches the diagnosis form. That same stream is the developer's primary debugging tool. So the "show your work" pitch and the on-call evidence trail are the **same NDJSON pipe**.

## Reading order

1. **`00-overview.md`** — orientation. The three observability surfaces, the through-line, the ranked findings, the honest gaps.
2. **`audit.md`** — Pass 1. The 8-lens walk against the codebase, each anchored to a `file:line`.
3. **`01-ndjson-agent-event-discriminated-union.md`** — the wire contract every observability surface shares. Read first.
4. **`02-replay-from-snapshot-with-paced-emission.md`** — how the committed snapshot becomes a reproducible debugging fixture.
5. **`03-three-rung-mem-file-seed-store.md`** — the postmortem evidence pattern: in-memory → dev-file → committed seed.
6. **`04-dual-write-send-to-stream-and-store.md`** — how the live route's stream and the cached snapshot stay in sync without two pipelines.
7. **`05-auth-secret-flake-postmortem.md`** — the production-only 500 incident: missing `AUTH_SECRET` → bare 500, fixed with a setup try/catch that surfaces the real message.

## Cross-links

- `study-testing` — the deterministic correctness gate. 24 files / 221 passing. Testing **catches known failure conditions before release**; this guide **explains unknown behavior with evidence after it happens**. The seam between the two: the test suite asserts the `AgentEvent` contract (`test/mcp/events.test.ts`, `test/streaming/ndjson.test.ts`); this guide explains how that contract becomes runtime evidence.
- `study-performance-engineering` — the per-phase wall-clock timings in `app/api/briefing/route.ts:204-206` and `app/api/agent/route.ts:216-219` belong to that guide's *measurement* lens. We touch them only as evidence for the "did the 300s budget burn before the failure?" incident question.
- `study-system-design` — the request-flow shape (NDJSON streaming, dual-route producers, demo replay) lives there. This guide explains what each event *means as evidence*, not how the routes are wired.
