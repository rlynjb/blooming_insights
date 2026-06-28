# Client stream handoff — sessionStorage as the cross-instance bridge

**Industry name:** client-mediated state hand-off · Project-specific (Vercel ephemeral pattern)

## Zoom out, then zoom in

Vercel's serverless instances are ephemeral. Step 2 of an investigation
(diagnose) may run on instance A; step 3 (recommend) may run on instance B
five seconds later. The two route invocations CANNOT rely on server-side
in-memory state to share the diagnosis. The fix: the BROWSER holds the
diagnosis in `sessionStorage` between the two HTTP requests and passes it
back via a query parameter on the next request.

You know how a multi-step form sometimes stashes the user's input in
`localStorage` so they don't lose it on a refresh? Same pattern, different
motivation. Here, the browser is the only piece of infrastructure with
guaranteed continuity across two HTTP requests to a serverless app — the
server might not be the same physical machine.

```
  Zoom out — where client stream hand-off lives

  ┌─ Browser ──────────────────────────────────────────────────────────────┐
  │  sessionStorage:                                                        │
  │    bi:insight:<id>       — insight payload, stashed by useBriefingStream │
  │    bi:diag:<id>          — diagnosis payload, stashed after step 2     │
  │    bi:inv:<step>:<id>    — full investigation state, for re-visit      │
  │    bi:reconnecting       — one-shot reset+reload guard                 │
  │                                                                         │
  │  ★ THE BRIDGE — only state that survives across Vercel instances ★      │ ← we are here
  └────────────────────────┬───────────────────────────────────────────────┘
                           │ HTTP requests carry the stashed payload
                           │ as `?insight=<json>`, `?diagnosis=<json>`
                           ▼
  ┌─ Service ──────────────────────────────────────────────────────────────┐
  │  step 2 instance A → step 3 instance B                                  │
  │  in-memory Maps are NOT shared across instances                         │
  │  the URL is — so the client carries the data instead                    │
  └────────────────────────────────────────────────────────────────────────┘
```

This file documents the THREE stashes (insight, diagnosis, full investigation
state) and the ONE recipe they all use: stash on success, hydrate on
re-visit, pass via query param on the next live request.

## Structure pass — layers, axis, seams

**Layers:** Server stream → React state → `sessionStorage` → next request
URL → next server stream.

**Axis (held constant): "who owns this data at this moment?"** This is the
right axis because the whole problem is ownership-transfer across a
request boundary.

```
  Axis: who owns the diagnosis at each moment?

  during step 2 stream:        SERVER owns it (in flight)
  step 2 'diagnosis' event:    SERVER → CLIENT (over NDJSON)
  step 2 'done' arrives:       CLIENT stashes (sessionStorage)
  step 2 → step 3 navigation:  CLIENT owns it
  step 3 request fires:        CLIENT → URL (?diagnosis=...)
  step 3 stream starts:        SERVER reads it from URL
  during step 3 stream:        SERVER owns it again (passed to agent)
```

Ownership flips four times across this flow. Each flip is a seam.

**Seams (boundaries where ownership flips):**

- **Server → client (NDJSON)** — the diagnosis arrives as a `'diagnosis'`
  event on the wire. From here, the client is responsible.
- **Client → sessionStorage** — the `'done'` event triggers
  `sessionStorage.setItem(diagHandoffKey(id), ...)` in
  `useInvestigation.ts:140`.
- **Client → URL** — step 3's `useInvestigation` reads
  `sessionStorage.getItem(diagHandoffKey(id))` and encodes it into the
  next request's `?diagnosis=` param (`useInvestigation.ts:172-174`).
- **URL → server** — the server parses `?diagnosis=` and passes the
  diagnosis to the RecommendationAgent (`/api/agent/route.ts:84-95,
  269`).

## How it works

### Move 1 — the mental model

The shape is **stash-and-replay**: the browser holds the data; each
HTTP request carries enough URL state to reconstruct the server-side
context.

```
  Pattern — sessionStorage as a cross-request bridge

   step 2 stream                              step 3 stream
   ─────────────                              ─────────────
   ┌──────────────┐                          ┌──────────────┐
   │ NDJSON       │  'diagnosis'             │ ?diagnosis=  │
   │ event        │ ─────────────►           │ query param  │
   └──────┬───────┘                          └──────┬───────┘
          │                                          ▲
          ▼                                          │
   ┌────────────────────────────────────────────┐    │
   │  sessionStorage[bi:diag:<id>] = JSON.stringify({ diagnosis })
   │  (browser-local; survives across requests)  │   │
   └──────────────┬─────────────────────────────┘    │
                  │                                   │
                  │  on step 3 navigation:            │
                  │  read it back, encode into URL    │
                  └──────────────────────────────────►┘
```

### Move 2 — the step-by-step walkthrough

#### Step 1 — three stashes, three jobs

```
  Three stashes, what each is for

  key                       written by           read by                  purpose
  ───                       ──────────           ───────                  ───────
  bi:insight:<id>           useBriefingStream    useInvestigation         pass anomaly across instances
                            (stashInsights)      (`?insight=` URL param)  via URL
  bi:diag:<id>              useInvestigation     useInvestigation         hand diagnosis from step 2 → 3
                            (after step 2 done)  (step 3 setup)
  bi:inv:<step>:<id>        useInvestigation     useInvestigation         hydrate full state on re-visit/back
                            (after done)         (mount check)            (avoid re-running agent)
  bi:reconnecting           useReconnectPolicy   useReconnectPolicy       one-shot reset+reload guard
                            (before reset)       (handle, on next error)
```

The first three are about request-to-request continuity; the last is
about not looping on token revocation. All four use the same
`sessionStorage` (per-tab, gone when the tab closes) — never
`localStorage`, because we don't want them to leak across tabs or
survive a browser restart.

#### Step 2 — stashing the insight on the briefing path

When the briefing stream emits each insight, the hook stashes it:

```typescript
// lib/hooks/useBriefingStream.ts:53-60
function stashInsights(list: Insight[]): void {
  if (typeof window === 'undefined') return;
  try {
    for (const i of list) sessionStorage.setItem(`bi:insight:${i.id}`, JSON.stringify(i));
  } catch {
    /* sessionStorage full/blocked — investigation falls back to server lookup */
  }
}
```

Then, when the investigation request fires, the hook reads it back:

```typescript
// lib/hooks/useInvestigation.ts:168-171 (abridged)
const stashed = sessionStorage.getItem(`bi:insight:${id}`);
if (stashed) url += `&insight=${encodeURIComponent(stashed)}`;
```

The server's `resolveAnomaly` (`app/api/agent/route.ts:35-60`) checks
the `?insight=` URL param FIRST, then falls back to in-memory lookup,
then to the demo snapshot:

```typescript
function resolveAnomaly(sessionId, insightId, insightParam): Anomaly | null {
  if (insightParam) {
    try {
      const i = JSON.parse(insightParam) as Insight;
      if (i && typeof i.metric === 'string' && i.change && Array.isArray(i.scope) && i.severity) {
        return insightToAnomaly(i);
      }
    } catch { /* malformed — fall through */ }
  }
  const a = getAnomaly(sessionId, insightId);
  if (a) return a;
  const i = getInsight(sessionId, insightId);
  if (i) return insightToAnomaly(i);
  try {
    if (existsSync(DEMO_FILE)) { /* fallback to demo seed */ }
  } catch {}
  return null;
}
```

**The order matters.** URL-param first because that's the only path
guaranteed to work across instances. In-memory second because it's
faster when it happens to be available (warm instance, recent
briefing). Demo seed last as a safety net.

```
  Layers-and-hops — the insight crossing instances

  ┌─ Browser ─────┐                         ┌─ Server (instance A) ─┐
  │ feed loads    │                         │                        │
  │ → GET /api/   │ ──────────────────────► │ MonitoringAgent.scan() │
  │   briefing    │                         │ → insights             │
  │               │                         │ → in-memory state      │
  │               │ ◄────── NDJSON ──────── │ → stream them          │
  │ stash each    │                         │                        │
  │ to            │                         └────────────────────────┘
  │ sessionStorage│
  └───────┬───────┘
          │ navigate to /investigate/X
          ▼
  ┌─ Browser ─────┐                         ┌─ Server (instance B) ─┐
  │ investigation │ ──────────────────────► │ resolveAnomaly:        │
  │ → GET /api/   │ with                    │  1. parse ?insight=    │
  │   agent       │ &insightId=X            │     (works! — fresh)    │
  │               │ &insight=<stashed json> │  2. in-memory miss      │
  │               │                         │  3. demo miss            │
  │               │                         │ → run DiagnosticAgent   │
  └───────────────┘                         └────────────────────────┘
```

#### Step 3 — stashing the diagnosis between step 2 and step 3

The most critical hand-off. Step 2 emits a `'diagnosis'` event in its
NDJSON stream; the client stashes it as soon as `'done'` arrives.

```typescript
// lib/hooks/useInvestigation.ts:131-145 (abridged)
case 'done':
  setComplete(true);
  try {
    sessionStorage.setItem(
      stashKey(step, id),                       // bi:inv:diagnose:<id> — full state
      JSON.stringify({ items: cItems, diagnosis: cDiag, recommendations: cRecs }),
    );
    // hand the diagnosis to step 3
    if (step === 'diagnose' && cDiag) {
      sessionStorage.setItem(
        diagHandoffKey(id),                     // bi:diag:<id> — just the diagnosis
        JSON.stringify({ diagnosis: cDiag }),
      );
    }
  } catch { /* stash is best-effort */ }
  break;
```

Two writes happen here. **One**: the full state stash for re-visits
(`bi:inv:diagnose:<id>`). **Two**: the diagnosis-specific hand-off
stash (`bi:diag:<id>`) for step 3.

When step 3 mounts, it reads the diagnosis back BEFORE starting the
stream:

```typescript
// lib/hooks/useInvestigation.ts:71-85 (abridged)
let handedDiagnosis: Diagnosis | null = null;
if (step === 'recommend') {
  try {
    const raw = sessionStorage.getItem(diagHandoffKey(id));
    if (raw) {
      const d = JSON.parse(raw) as { diagnosis?: Diagnosis };
      handedDiagnosis = d.diagnosis ?? null;
      cDiag = handedDiagnosis;
      if (handedDiagnosis) setDiagnosis(handedDiagnosis);
    }
  } catch { /* ignore */ }
}
```

Then it encodes the diagnosis into the URL for the live request:

```typescript
// lib/hooks/useInvestigation.ts:171-174 (abridged)
if (step === 'recommend' && handedDiagnosis) {
  url += `&diagnosis=${encodeURIComponent(JSON.stringify(handedDiagnosis))}`;
}
```

The server's step-3 branch parses it (`/api/agent/route.ts:84-95`):

```typescript
function parseDiagnosis(param: string | null): Diagnosis | null {
  if (!param) return null;
  try {
    const d = JSON.parse(param);
    if (d && typeof d.conclusion === 'string' && Array.isArray(d.evidence) && Array.isArray(d.hypothesesConsidered)) {
      return d as Diagnosis;
    }
  } catch { /* ignore */ }
  return null;
}
```

And uses it (`/api/agent/route.ts:268-272`):

```typescript
if (step === 'recommend') {
  diagnosis = parseDiagnosis(diagnosisParam);
  if (!diagnosis) {
    throw new Error('no diagnosis was handed over — open the diagnosis step first');
  }
}
```

The error message is the proof the hand-off is mandatory: there's no
server-side fallback. The browser MUST carry the diagnosis; if it
doesn't, step 3 fails fast.

#### Step 4 — the full-state stash (`bi:inv:<step>:<id>`)

Beyond the hand-off, the hook stashes the FULL investigation state
(trace items, diagnosis, recommendations) under a step-keyed slot. On
re-visit, the hook hydrates from this slot INSTEAD of re-running the
agent:

```typescript
// lib/hooks/useInvestigation.ts:52-64 (abridged)
// 1) hydrate from this step's stash (re-visit / back-nav).
try {
  const raw = sessionStorage.getItem(stashKey(step, id));
  if (raw) {
    const s = JSON.parse(raw) as Partial<InvestigationState>;
    setItems(s.items ?? []);
    setDiagnosis(s.diagnosis ?? null);
    setRecommendations(s.recommendations ?? []);
    setComplete(true);
    return;     // ← early return; no fetch happens
  }
} catch { /* ignore — fall through to a live/replay fetch */ }
```

This is the "back button works correctly" hand-off — without it, the
user clicking back from step 3 to step 2 would re-run the diagnostic
agent (another ~50s, another budget burn). With it, the page hydrates
from the cached state instantly.

```
  Three storage slots, three lifecycles

  bi:insight:<id>     ← stashed once per briefing, read every investigation
  bi:diag:<id>        ← stashed once per step-2-done, read once on step-3-mount
  bi:inv:<step>:<id>  ← stashed once per step-done, read on re-mount / back-nav
```

#### Step 5 — the reconnect flag (`bi:reconnecting`)

The fourth stash isn't a data hand-off; it's a one-shot guard against
infinite reconnect loops. When the auth-error reconnect fires,
`useReconnectPolicy` sets the flag; on the NEXT auth error in the same
tab, the flag is read, found, and the hook bails out (rather than
reloading again).

```typescript
// lib/hooks/useReconnectPolicy.ts:84-110 (abridged)
const handle = useCallback((msg: string): boolean => {
  if (!isAuthErrorAuto(msg)) return false;
  if (typeof window === 'undefined') return false;
  let alreadyTried = false;
  try {
    alreadyTried = sessionStorage.getItem(FLAG_KEY) === '1';
  } catch { /* ignore */ }
  if (alreadyTried) {
    try { sessionStorage.removeItem(FLAG_KEY); } catch {}
    return false;     // ← second consecutive auth error — give up, show error UI
  }
  try { sessionStorage.setItem(FLAG_KEY, '1'); } catch {}
  fireReset();        // ← first auth error — POST /api/mcp/reset, then reload
  return true;
}, [fireReset]);
```

The flag is cleared on the success path
(`useBriefingStream.ts:271`, via `callbacks.onStreamComplete`).

#### Step 6 — what's NOT stashed

The agent's tool-call results are NOT stashed in sessionStorage. They
flow through the NDJSON stream into the React state, but they're not
persisted across requests — too large, too session-specific, and the
investigation cache on the server side handles replay if needed.

This is a deliberate non-feature: pushing every tool result into
sessionStorage would blow the ~5MB browser quota on a long
investigation, and the user doesn't need to re-see them on a re-visit
(they get the diagnosis and recommendations, which is what the
investigation page actually shows).

### Move 3 — the principle

**When the server can't be relied on for continuity, put the state on
the client.** This is the Vercel serverless reality: ephemeral
instances, in-memory state that doesn't survive across requests, no
shared cache by default. The browser is the only piece of
infrastructure with a guaranteed continuity model — `sessionStorage`
lives as long as the tab does, and that's enough for a multi-step
workflow.

The general principle, beyond this codebase: **state ownership should
follow the lifecycle**. The diagnosis lives across step 2's response
and step 3's request — neither of those lives on the server. It lives
in the tab — exactly as long as the user's session does. The browser
owns it because the browser is the only thing that's still around for
its whole lifecycle.

You'll see the same pattern in any serverless or multi-instance
architecture: JWT tokens (the client carries the auth state), cursor-
based pagination (the client carries the cursor), HATEOAS (the client
carries the next-action URL). The shape is always "encode the state
into the request, let the server be stateless."

## Primary diagram

```
  Client stream hand-off — one full step-2 → step-3 flow

  ┌─ Browser (tab) ──────────────────────────────────────────────────────────┐
  │                                                                            │
  │  Step 2: /investigate/<id>                                                 │
  │  ┌─ useInvestigation('diagnose') ───────────────────────────────────┐    │
  │  │  fetch GET /api/agent?insightId=X&step=diagnose                  │    │
  │  │          &insight=<sessionStorage[bi:insight:X]>                  │    │
  │  │  readNdjson:                                                       │    │
  │  │    'reasoning_step' / 'tool_call_*' / 'diagnosis' (← cDiag = it) │    │
  │  │    'done':                                                         │    │
  │  │      sessionStorage[bi:inv:diagnose:X] = { items, diagnosis, recs}│    │
  │  │      sessionStorage[bi:diag:X]         = { diagnosis: cDiag }     │    │
  │  └────────────────────────────────────────────────────────────────────┘    │
  │                                                                            │
  │  navigate to /investigate/<id>/recommend                                   │
  │                                                                            │
  │  Step 3: /investigate/<id>/recommend                                       │
  │  ┌─ useInvestigation('recommend') ──────────────────────────────────┐    │
  │  │  on mount: handedDiagnosis = JSON.parse(                          │    │
  │  │              sessionStorage[bi:diag:X]).diagnosis                  │    │
  │  │            setDiagnosis(handedDiagnosis) // show it in the UI now │    │
  │  │  fetch GET /api/agent?insightId=X&step=recommend                  │    │
  │  │          &insight=<sessionStorage[bi:insight:X]>                  │    │
  │  │          &diagnosis=<encoded handedDiagnosis>                     │    │
  │  │  readNdjson:                                                       │    │
  │  │    'tool_call_*' / 'recommendation' × N / 'done':                  │    │
  │  │      sessionStorage[bi:inv:recommend:X] = { ... }                  │    │
  │  └────────────────────────────────────────────────────────────────────┘    │
  │                                                                            │
  └────────────────────────────────────────────────────────────────────────────┘

  Server side (may be different Vercel instance per request):

  ┌─ /api/agent — step 2 ─────────────────────────┐  ┌─ /api/agent — step 3 ────────────────────┐
  │ anomaly = resolveAnomaly(sid, X, ?insight=)   │  │ anomaly = resolveAnomaly(sid, X, ?insight=) │
  │   → uses ?insight= (works across instances)   │  │   → uses ?insight= (works across instances) │
  │ DiagnosticAgent.investigate(anomaly)          │  │ diagnosis = parseDiagnosis(?diagnosis=)      │
  │ send { type: 'diagnosis', diagnosis }         │  │ if !diagnosis: throw                          │
  │ send { type: 'done' }                          │  │ RecommendationAgent.propose(anomaly, diagnosis)│
  └────────────────────────────────────────────────┘  └─────────────────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** Two parents:

  → **Stateless server architectures** (REST, the original 12-factor
    apps) — the server doesn't keep client state; the client passes
    whatever's needed on each request. JWT tokens are the canonical
    example; cursor pagination is the same pattern for list APIs.
  → **Browser-resident state** (Web Storage API, ~2009) — gave
    JavaScript a place to put state that survives requests but is
    scoped to the browser, with `sessionStorage` (per-tab) vs
    `localStorage` (cross-tab, persistent) as the two scopes.

The combination in a Vercel / serverless context is the modern shape.
You'd see exactly the same hand-off in any multi-step workflow on
serverless platforms (Vercel, Netlify Functions, Cloudflare Workers,
AWS Lambda) where in-process state has no continuity guarantee.

**The deeper principle.** Lifecycle-aware state placement. Ask: how
long does this state need to live? Whose lifecycle does it match?

  → request-scoped: put it in route-handler locals (the agent's
    in-memory loop state)
  → cross-request, same-user, same-tab: put it in sessionStorage
    (the diagnosis hand-off)
  → cross-request, same-user, cross-tab: put it in localStorage
    (the `bi:mode` toggle)
  → cross-user: put it in shared infrastructure (none in this codebase)

The diagnosis matches the "cross-request, same-user, same-tab"
lifecycle exactly. SessionStorage is the right slot.

**Where it breaks.**

- **URL length ceiling.** Browsers cap URLs around 8KB; a verbose
  diagnosis with long evidence strings could exceed that. The
  `?diagnosis=` param goes in the URL, not the request body (because
  the route is a GET). If we ever hit this, we'd need to switch to
  POST with a body — at which point the streaming-response shape gets
  weirder (POSTs to streaming responses are unusual; many CDNs
  don't cache them).
- **sessionStorage quota.** Browsers offer ~5MB per origin per tab.
  Today's payloads (one diagnosis, one insight, one investigation
  state per id) are tiny — well under 100KB. A future "stash every
  tool call's full result" would blow this fast.
- **JSON serialization round-trip.** Anything not JSON-serializable
  (Dates, Maps, undefined values) gets coerced. We only stash plain
  objects, but if a future field is a Date, it becomes a string in
  the round-trip — the diagnostic parse on the server side has to
  account for it.
- **No cross-tab continuity.** If the user opens step 3 in a new tab
  via right-click, the diagnosis isn't there — different tab,
  different sessionStorage. We'd need `localStorage` to fix this, and
  then we'd have to manage cleanup (sessionStorage cleans up on tab
  close; localStorage doesn't).
- **The `Mismatched-instance` failure looks like "step 3 failed."**
  If step 2 wrote the diagnosis but step 3 lands on an instance that
  can't reach the user's session (unlikely but possible during a
  deploy), the server still throws "no diagnosis was handed over"
  because the URL param resolves the data — but the trace shows the
  wrong shape. Worth knowing during debugging.

**What to explore next.**

- `07-multi-agent-orchestration.md` — the agent pipeline that drives
  this hand-off
- `02-oauth-boundary.md` — the other "browser carries the state"
  pattern in this codebase (encrypted cookie for OAuth)
- `06-streaming-ndjson.md` — the wire format that delivers the
  diagnosis from server to client
- `study-runtime-systems` — sessionStorage internals, JSON round-trip
  costs

## Interview defense

#### Q: "Why sessionStorage instead of a server-side session store like Redis?"

Three reasons. **One**: there is no shared infrastructure in this
project — adding Redis or Vercel KV just for an investigation
hand-off is overhead the demo doesn't justify. **Two**: the data is
already private to the tab (it's the user's investigation; no
cross-tab use case). **Three**: sessionStorage matches the lifecycle
exactly — it lives as long as the tab does, and the diagnosis only
needs to live across two adjacent requests in that tab. There's
nothing to clean up.

```
  Lifecycle match — sessionStorage vs alternatives

  storage          lifetime              matches our need?
  ───────          ────────              ────────────────
  in-memory map    warm instance         NO — cross-instance fails
  Redis            forever               OVER-PROVISIONED + cost
  cookie           1-N days              OVER-PROVISIONED + size
  sessionStorage   tab session           EXACTLY RIGHT
  localStorage     persistent            cross-tab leak risk
```

**Surface:** "lifecycle-matched, no infra needed, no cleanup."
**Probe:** if pressed — name the URL size ceiling and the
`error('no diagnosis was handed over')` path as the failure case.

#### Q: "What's the load-bearing part — what breaks if you remove this hand-off?"

The `bi:diag:<id>` stash + the `?diagnosis=` parse. It's the kernel
that lets step 2 and step 3 run as two separate HTTP requests. Strip
it out and you have two options:

  → **revert to a single combined request** — works, but you lose
    the budget split (a 100s combined call hits the 300s ceiling
    eventually) and the URL navigation feels less like a real
    multi-step workflow
  → **add server-side shared state** — Redis/KV/something. Requires
    new infrastructure, monthly cost, and a cleanup story
    (we'd need to expire diagnoses on some schedule)

The current shape is the minimum. Drop the stash and the recommend
agent gets `null` for the diagnosis; its prompt has no investigated
cause to reason about; the recommendations would be generic and the
product loses its "shows its work" pitch.

Other load-bearing parts (in order):

  → the `bi:insight:<id>` stash — same problem as the diagnosis,
    one layer earlier (anomaly hand-off)
  → the `resolveAnomaly` fallback order (param → memory → demo) —
    without the param-first ordering, the cross-instance case fails
  → the JSON.parse + structural check on the server side — without
    it, a tampered query param would crash the route
  → the full-state stash (`bi:inv:<step>:<id>`) — quality-of-life;
    without it, the back button re-runs the agent

Optional hardening:

  → the try/catch around sessionStorage operations — privacy mode
    can block storage; we degrade to the in-memory lookup path
  → encodeURIComponent on the URL params — prevents `&` in the
    payload from corrupting the URL

#### Q: "What happens if the user opens step 3 in a new tab via right-click?"

The diagnosis isn't there — different tab, different sessionStorage.
The hook reads `bi:diag:<id>` and finds nothing; the request fires
without `?diagnosis=`; the server throws "no diagnosis was handed
over"; the UI shows the error.

This is a real UX gap. The fix would be:

  → option A: use localStorage instead — works across tabs but we'd
    have to clean up (no auto-expiry) and we'd have to think about
    multiple-investigation collisions
  → option B: server-side shared store (Vercel KV) — costs $$, but
    handles cross-tab + cross-instance uniformly
  → option C: encode the diagnosis into the URL of the link to
    step 3 — but the URL would be huge, especially for verbose
    diagnoses (see the URL length concern above)

Today this is filed as a known limitation; the typical user flow is
"click → step 2 → click 'see recommendations' → step 3" in one tab,
and that works perfectly.

## See also

- `00-overview.md` — where this sits in the whole system
- `07-multi-agent-orchestration.md` — the pipeline this hand-off serves
- `02-oauth-boundary.md` — the OTHER "browser carries state" pattern
  in this codebase (encrypted cookie for OAuth)
- `06-streaming-ndjson.md` — the wire that delivers the diagnosis
- `study-runtime-systems` — sessionStorage internals, browser quotas
