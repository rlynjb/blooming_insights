# 07 — Demo replay as reliability

**Industry name:** deterministic-fixture replay path, hidden but preserved. *Type: Project-specific (idiomatic).*

## Zoom out, then zoom in

Portfolio demos happen on stage, in front of hiring managers,
sometimes on hotel Wi-Fi. The alpha MCP server rate-limits and
revokes tokens. The right move is to have a path that shows
the product working — every card, every trace, every impact
callout — without any network call and without any dependency
on the live server. That's what the demo replay path does.

It used to be the *default* mode. As of Session A, `demo` is
hidden from the UI toggle (still reachable by URL param or
manual localStorage set), and the default is `live-synthetic`.
The reasoning: agents-on-fake-data is a more honest first
impression than replayed-agents. Demo is preserved because it
still earns its keep as a reliability path and a regression
baseline.

```
  Zoom out — where demo replay sits

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  ProcessStepper · InsightCard · StatusLog · Evidence    │
  │  the UI can't tell demo from live                       │
  └────────────────────┬────────────────────────────────────┘
                       │  fetch('?demo=cached')
  ┌─ Service layer ────▼────────────────────────────────────┐
  │  route sees demo=cached BEFORE mode branch:             │
  │  ★ read committed JSON snapshot; return as NDJSON ★     │
  └────────────────────┬────────────────────────────────────┘
                       │  no factory, no adapter, no agent
  ┌─ Storage layer ────▼────────────────────────────────────┐
  │  lib/state/demo-insights.json                           │
  │  lib/state/demo-investigations.json                     │
  │  committed to git — the source of truth for demo mode   │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is fixture replay — record real
output once, commit it, serve it verbatim thereafter. What
makes it interesting in this repo is that the replay is
*event-shaped*, not payload-shaped: the JSON on disk is the
sequence of NDJSON events the agent originally emitted, and
the route replays them at speed with tiny delays so the UI
still sees a "streaming" effect.

## Structure pass

Two layers (route decision / replay execution), one axis:
**how does the client tell demo from live?**

```
  Axis "how does the client know it's a demo?" — down the layers

  ┌─ Client ────────────────────────────────────────────────┐
  │  reads:  bi:mode = 'demo' (or ?demo=cached in URL)      │
  │  fetch:  /api/briefing?mode=demo (or ?demo=cached)      │
  │  parse:  same readNdjson kernel, same event union       │
  └───────────────────────┬─────────────────────────────────┘
                          │  seam: query param sniffed at route entry
  ┌─ Server ───────────────▼────────────────────────────────┐
  │  demo path:   read JSON, replay events, return          │
  │  live path:   makeDataSource, agent.run, stream events  │
  │                                                         │
  │  ★ the client's readNdjson kernel is identical ★        │
  │  ★ the AgentEvent shapes on the wire are identical ★    │
  └─────────────────────────────────────────────────────────┘
```

The seam is `mode=demo` (query param). Above it, the client
doesn't need to know. Below it, the route takes a completely
different code path — no factory, no adapter, no agent, no
Anthropic API call. That's the reliability property: nothing
between the fetch and the response can flake.

## How it works

### Move 1 — the mental model

You've used a Storybook mock — same idea. Record the shape
once, replay it forever. The twist here is that "the shape"
is a stream of NDJSON events, not a single payload. So the
snapshot on disk holds every event in order.

```
  Pattern — record once, replay N

  ┌─ live capture (one-time) ──────────────────────┐
  │  agent runs against real MCP server            │
  │  capture handler stashes every AgentEvent      │
  │  writes lib/state/demo-*.json                  │
  │  → commit to git                               │
  └──────────────┬──────────────────────────────────┘
                 │
                 ▼
  ┌─ replay (every demo, forever) ─────────────────┐
  │  route reads committed JSON                     │
  │  emits events with tiny artificial delays       │
  │  filtered per step (agent tag on each event)    │
  └────────────────────────────────────────────────┘
```

### Move 2 — step by step

**Part 1: the committed snapshots.** Two JSON files:
`lib/state/demo-insights.json` (feed snapshot: workspace +
insights + monitoring trace) and `lib/state/demo-investigations.json`
(per-insight investigations: diagnosis + recommendations + full
trace, keyed by insight id).

The invariant the project context calls out:

> The demo snapshot keys (`insights`, `workspace`, `trace`)
> and the per-step replay filter (events tagged by `agent`).

Every event in the committed JSON carries an `agent` tag
(`monitoring` / `diagnostic` / `recommendation`) so the
per-step replay can filter to just the relevant slice.

**Part 2: capture** (dev-only, one-click). The feed page has
a "capture this as the demo snapshot" button, gated to
development. It runs the live briefing + each investigation
end-to-end, buffering every emitted event, then POSTs the
combined snapshot to `/api/mcp/capture-demo`, which writes
the two JSON files.

**Part 3: the replay branch on the route.** Sniffed at the
top of the handler, before the mode branch, before the setup
call.

```
  Layers-and-hops — the two paths diverge at the route

  ┌─ Browser ─────────┐
  │  useBriefingStream│
  └────────┬──────────┘
           │  fetch('/api/briefing?demo=cached')  OR  '?mode=<x>'
           ▼
  ┌─ Route entry ─────────────────────┐
  │  demo=cached?                     │
  │  ─── yes ─────────┐               │
  │                   │               │
  │                   ▼               │
  │        ┌─ demo replay ─┐          │
  │        │  read JSON    │          │
  │        │  replay events│          │
  │        │  return NDJSON│          │
  │        └───────────────┘          │
  │                   ▲               │
  │  ─── no ──────────┼───────────    │
  │                   │               │
  │                   ▼               │
  │        ┌─ live path ───────┐      │
  │        │  parseLiveMode    │      │
  │        │  decodeConfig     │      │
  │        │  makeDataSource   │      │
  │        │  agent.run + stream│     │
  │        └───────────────────┘      │
  └───────────────────────────────────┘
```

The demo path emits its events with small artificial delays
(fast enough to feel instant, slow enough that the
`ProcessStepper` and `StatusLog` animations register). No
external I/O, no Anthropic API call, no MCP server.

**Part 4: the per-step filter.** For investigations, the
committed JSON holds the full trace (both diagnostic and
recommendation phases). Step 2 replays only the diagnostic
events (filtered by `agent === 'diagnostic'`); step 3 replays
only the recommendation events. The client's `useInvestigation`
hook streams them into `StatusLog` identically to the live
path.

**Part 5: `?demo=cached` as the URL fallback.** Even though
the mode toggle no longer shows `demo`, the path is reachable:

- URL param: append `?demo=cached` to any URL.
- Manual localStorage: set `bi:mode` to `'demo'` in devtools.

The path stays visible for portfolio use (reliable
presentation), for regression baselines, and for offline dev.

**Part 6: what makes it a *reliability* path.**

- Zero external dependencies: no network calls out.
- Deterministic: the same JSON produces the same output every
  time. Every card renders, every impact callout shows, every
  trace line lands.
- Fast: no rate-limit spacing, no OAuth handshake, no ~10s
  retry ladder waits.
- Fault-tolerant against the LLM going sideways: the model
  outputs are already baked into the snapshot.

**Part 7: what it's NOT.**

- Not the default. `live-synthetic` shows the real agent loop
  against fake data — a more honest first impression.
- Not a regression baseline for the agents themselves (the
  agents don't run). The eval harness owns agent regression.
- Not a substitute for real MCP integration testing.

### Move 3 — the principle

Reliability paths pay for themselves when the environment you
demo in is different from the environment you build in. Ship
one code path if you can; ship a second, hidden, deterministic
one when the first can flake in front of an audience. The
discipline is: keep the two paths' *client-side contracts*
identical (same events, same UI code path), so the fixture
replay is a strict subset of the live experience — not a
different-looking substitute.

## Primary diagram

```
  Demo replay — full recap

  ┌─ Live capture (once, dev-only) ──────────────────────┐
  │  agent runs real Bloomreach path                     │
  │  capture handler buffers every AgentEvent            │
  │  POST /api/mcp/capture-demo → writes                 │
  │    lib/state/demo-insights.json                      │
  │    lib/state/demo-investigations.json                │
  │  git add + commit                                    │
  └────────────────────┬─────────────────────────────────┘
                       │  ★ committed to repo ★
                       ▼
  ┌─ Demo replay (every time, no network) ───────────────┐
  │  browser:                                             │
  │    ?demo=cached  OR                                   │
  │    localStorage.setItem('bi:mode', 'demo')            │
  │    → fetch('/api/briefing?mode=demo')                 │
  │                                                       │
  │  route:                                               │
  │    if (mode === 'demo') {                             │
  │      const snapshot = readJson('demo-insights.json'); │
  │      return replayAsNdjson(snapshot);                 │
  │    }                                                  │
  │                                                       │
  │  browser (unchanged):                                 │
  │    readNdjson(res.body, onEvent)                      │
  │    UI renders identically to live                     │
  └──────────────────────────────────────────────────────┘
```

## Elaborate

Fixture replay is the oldest reliability pattern in testing —
Ruby's VCR, Node's nock, mock-service-worker for browser
testing. The interesting piece here isn't the pattern; it's
that the fixture is *event-shaped* (a stream of NDJSON events)
rather than payload-shaped (one response body). The route
replays them at speed, so the client can't tell the difference
from a slow but successful live stream.

The choice to hide but preserve `demo` mode (Session A) is a
"prefer hide over delete" move. Removing the code would give
up the reliability property; hiding the entry point removes
the discoverability. The path stays functional; only the
visible affordance changes.

Adjacent reliability patterns worth naming: (1) VCR cassettes
in Rails tests replay HTTP requests deterministically; (2)
Storybook stories are UI-shaped fixtures; (3) golden files in
Go tests capture stdout/stderr for regression. Same idea:
record real behavior, commit it, replay identically. The
common ancestor is "your integration test shouldn't need the
integration to be live."

## Interview defense

**Q: Why keep the demo path if the default is now synthetic?**

A: Two reasons. First, reliability for portfolio demos —
`live-synthetic` runs the real Anthropic API and can fail if
the model has a bad day; demo replay can't. Second,
regression evidence — the committed JSON is a durable record
of "here's what the product looked like at a specific point in
time." Deleting it would give up both properties.

**Q: How do you keep the demo snapshot fresh?**

A: The one-click capture button in dev mode. Run it against a
healthy live path, commit the resulting `demo-*.json` files.
The refresh cadence is manual — this is a portfolio project,
not a product with a release train.

**Q: What's the one thing people forget about fixture replay?**

A: The client-side contract has to stay identical. If the
live path emits a new event type and the demo replay doesn't,
the UI silently misses features on the demo path. The
discipline is: any change to `AgentEvent` gets a re-capture
before it ships.

**Q: What about drift — the fixture doesn't match live
anymore?**

A: Accepted risk. The fixture is a snapshot from a specific
day; the live path evolves. The audit calls this out
implicitly: the fixture is a reliability path, not a
correctness path. The correctness path is `live-synthetic`
(deterministic fake data through the real agent loop) plus
the eval harness (regression gate on baseline vs candidate).

## See also

- `01-request-flow.md` — where the demo branch fits in the
  route
- `05-streaming-ndjson.md` — the client-side kernel that
  parses both live and replayed streams
- `03-provider-abstraction-and-datasource-seam.md` — the
  live path the demo path substitutes for
