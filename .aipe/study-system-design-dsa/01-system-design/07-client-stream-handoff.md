# Client stream handoff

**Industry name(s):** single-run effect under React StrictMode (started-guard, no-cancel-on-cleanup); client-side state handoff via `sessionStorage`; per-step result memoization
**Type:** Industry standard (React) · Framework-specific to React 18+ StrictMode

> `useInvestigation` is one client hook that runs a `fetch` reader loop over `/api/agent` exactly once per mount even under StrictMode's double-invoke, stashes each step's result in `sessionStorage` so re-visits hydrate without re-running the agents, and carries the step-2 diagnosis forward to step 3 — because Vercel's per-instance memory cannot.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Client stream handoff lives in the UI band and the network boundary — `lib/hooks/useInvestigation.ts` runs the `fetch` reader loop, owns the `startedRef` latch that survives React StrictMode's double-invoke, and writes/reads four `sessionStorage` keys (`bi:insight:<id>`, `bi:inv:<step>:<id>`, `bi:diag:<id>`) that bridge boundaries the *server* cannot. The route handler on the other side reads `?insight=` and `?diagnosis=` from the query string because Vercel's per-instance memory can't carry an insight from the feed request to the investigation request, or a diagnosis from step 2 to step 3.

```
Zoom out — where client stream handoff lives

┌─ UI ───────────────────────────────────────────┐  ← we are here
│  app/page.tsx (feed: stash bi:insight:<id>)    │
│  ★ lib/hooks/useInvestigation.ts ★            │
│    · startedRef latch (StrictMode-safe)       │
│    · sessionStorage 4 keys (cross-nav state)  │
│    · reader loop (NDJSON consumer)            │
│  app/investigate/[id]/page.tsx (diagnose)      │
│  app/investigate/[id]/recommend/page.tsx       │
└─────────────────────┬──────────────────────────┘
                      │  /api/agent?insightId=&step=
                      │   &insight=<from sessionStorage>
                      │   &diagnosis=<from sessionStorage>
┌─ Network boundary ──▼──────────────────────────┐
│  serverless: instance A ≠ instance B           │
└─────────────────────┬──────────────────────────┘
                      │
┌─ Route handler ────────────────────────────────┐
│  app/api/agent/route.ts                        │
│  resolveAnomaly: prefer ?insight= over         │
│    getAnomaly(id) (empty on a fresh instance)  │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you run an effect's `fetch` exactly once under React StrictMode's double-invoke, keep each step's result alive across a route change, and feed the server state it can't remember on its own — without `EventSource`, without React Query, without a backend session store? The answer is three storage tiers (`useRef` latch for the in-process double-invoke, `useState` for live UI, `sessionStorage` for navigation + cross-instance handoff) plus one rule: *don't cancel the in-flight stream on effect cleanup*. The next sections walk the started-guard, the four `sessionStorage` keys, the diagnosis handoff that turns step 2's `done` event into step 3's `&diagnosis=` URL parameter, and the feed's insight handoff that lets a Vercel instance B serve a card produced by instance A.

---

## How it works

**Move 1 — mental model: the hook is a state machine with three storage tiers.**

The hook owns five `useState` slots (`items`, `diagnosis`, `recommendations`, `complete`, `error`) and one `useRef` (`startedRef`). On mount it checks `sessionStorage` for a cached result before it ever touches the network. The network path writes back to `sessionStorage` on `done`. Storage is the durable tier; React state is the live tier; the ref is the run-once latch.

```
┌──────────────────────────────────────────────────────────────────┐
│  useInvestigation(id, step)                                       │
│                                                                   │
│  startedRef  (useRef)   ── run-once latch, survives re-render     │
│  items/diagnosis/…      (useState) ── live UI tier                │
│  sessionStorage         ── durable tier, survives route change    │
│                                                                   │
│  mount ──▶ startedRef.current?  ──yes──▶ return (no second run)   │
│                  │ no                                              │
│                  ▼                                                │
│           startedRef.current = true                               │
│                  │                                                │
│                  ▼                                                │
│           bi:inv:<step>:<id> in storage?                          │
│            ──yes──▶ hydrate state, setComplete(true), return      │
│            ──no───▶ open fetch reader, stream into state,         │
│                     stash on `done`                               │
└──────────────────────────────────────────────────────────────────┘
```

The latch is a `useRef`, not `useState`, on purpose: changing a ref does not trigger a re-render, and its value persists across the StrictMode mount → re-mount because React reuses the same fiber.

### The started-guard + no-cancel-on-cleanup pattern

React 18 StrictMode (dev only) intentionally double-invokes effects to surface cleanup bugs: it runs the effect, runs its cleanup, then runs the effect again. The textbook fix is an `AbortController`/`reader.cancel()` in the cleanup. That fix is wrong here because the work is a one-shot stream, not a cancellable subscription — cancelling the first run leaves nothing for the re-run to show.

```
  StrictMode dev cycle:
  mount ──▶ effect run #1 ──▶ cleanup ──▶ effect run #2

  ── with reader.cancel() in cleanup ──
  run #1 opens stream ──▶ cleanup cancels it ──▶ run #2 …
     (run #2 either re-fetches [double cost] or is blocked by a guard
      that ALSO blocked the only completing stream → empty logs)

  ── this codebase: started-guard, NO cancel ──
  run #1: startedRef.current = true; opens stream (completes) ✓
  cleanup: does nothing
  run #2: startedRef.current already true → returns immediately
     result: exactly one stream, runs to completion
```

The guard is two lines at the top of the effect: `if (startedRef.current) return;` then `startedRef.current = true;`. The in-flight async IIFE is never told to stop. When the component unmounts (real unmount, e.g. route change away mid-stream), the pending `setItems`/`setDiagnosis` calls fire after unmount — React drops them with a no-op (no warning in React 18+). The cost is a tiny amount of wasted work on a true mid-stream navigation; the benefit is correctness under StrictMode and zero double-fetch.

### Per-step result stash

Each step caches its full result under a step-scoped key so a re-visit or browser back-button hydrates instantly instead of re-running a 40-second agent.

```
  key builders:
  stashKey('diagnose',  id) → "bi:inv:diagnose:<id>"
  stashKey('recommend', id) → "bi:inv:recommend:<id>"

  on `done` event:
  sessionStorage.setItem(
    "bi:inv:<step>:<id>",
    JSON.stringify({ items: cItems, diagnosis: cDiag, recommendations: cRecs })
  )

  on next mount (hydrate path):
  raw = sessionStorage.getItem("bi:inv:<step>:<id>")
  if raw: setItems / setDiagnosis / setRecommendations from parsed; setComplete(true); RETURN
          (no fetch — the agents never run)
```

Note the stash mirrors the result in plain closure arrays (`cItems`, `cDiag`, `cRecs`) alongside React state. React state updates are async and batched; the hook cannot read the freshest `items` synchronously inside the `done` handler, so it accumulates a parallel plain-array copy and stashes that. The two are kept in lockstep — every event handler pushes/mutates both the closure mirror and the React state.

### The diagnosis handoff: step 2 → step 3

Step 2 runs only the diagnostic agent. Step 3 (`/recommend`) needs the diagnosis as input but is a separate page with separate state. The handoff is a dedicated `sessionStorage` key written by step 2's `done` handler and read by step 3's mount.

```
  STEP 2  /investigate/[id]            STEP 3  /investigate/[id]/recommend
  ────────────────────────            ──────────────────────────────────
  diagnostic agent runs
  `done` fires:
    stash bi:inv:diagnose:<id>
    if cDiag:
      stash bi:diag:<id>  ──────────┐
        = { diagnosis: cDiag }      │
                                    ▼
                              mount: read bi:diag:<id>
                              handedDiagnosis = parsed.diagnosis
                              setDiagnosis(handedDiagnosis)  (shown for context)
                              │
                              ▼ live mode only:
                              url += "&diagnosis=" + encode(JSON(handedDiagnosis))
                              ─────────────────────────────────▶ /api/agent
                                  (server reads ?diagnosis=, feeds the
                                   recommendation agent — no re-diagnose)
```

In demo (cached) mode the server replays the cached snapshot filtered to the `recommend` step, so the diagnosis stash is only needed for on-screen context. In live mode the diagnosis is *also* sent as the `&diagnosis=` query param so the server's recommendation agent receives it directly — the client carries the agent's own prior output back to the agent.

### The feed's insight handoff

The feed (`app/page.tsx`) stashes every insight under `bi:insight:<id>` the moment the briefing loads. When the user clicks a card and the investigation page fires `/api/agent`, the hook reads `bi:insight:<id>` and sends it as `&insight=`. This is the load-bearing handoff on Vercel.

```
  FEED request (Vercel instance A)        INVESTIGATION request (instance B)
  ──────────────────────────────         ──────────────────────────────────
  briefing returns insights
  stashInsights():
    for each i: setItem(
      bi:insight:<i.id>, JSON(i))         hook reads bi:insight:<id>
         │ (lives in the browser)         url += "&insight=" + encode(JSON(insight))
         └────────────────────────────▶   ───────────────────────────────▶ /api/agent
                                          server resolveAnomaly() prefers
                                          ?insight= over its own in-memory
                                          getAnomaly(id) — which is EMPTY on
                                          instance B (never saw the feed run)
```

Vercel serverless functions do not share memory between invocations. The anomaly the monitoring agent computed on instance A is not in instance B's `getAnomaly` map. Without the browser carrying it across, the investigation returns "insight not found." The `sessionStorage` round-trip is the cross-instance state channel.

**Move 3 — the principle.** When the backend cannot hold state between two requests (StrictMode double-invoke, serverless per-instance memory, page navigation), the client must own it. `sessionStorage` is the client's durable map; the started-guard is the client's idempotency key; the query param is the client's way of handing the backend exactly the state it forgot.

---

## Client stream handoff — diagram

The full lifecycle of one investigation, from feed click to step 3, showing every storage hop.

```
┌────────────────────────────────────────────────────────────────────────┐
│  BROWSER (sessionStorage persists across all of these)                  │
│                                                                          │
│  FEED  app/page.tsx                                                      │
│   briefing done → stashInsights() → setItem bi:insight:<id> = JSON(i)    │
│        │                                                                 │
│   click card ──▶ route to /investigate/<id>                             │
│        ▼                                                                 │
│  STEP 2  useInvestigation(id, 'diagnose')                               │
│   startedRef? no → set true                                             │
│   bi:inv:diagnose:<id>? ──hit──▶ hydrate + setComplete, RETURN          │
│        │ miss                                                           │
│        ▼                                                                 │
│   build url: /api/agent?insightId=<id>&step=diagnose                    │
│     live? += &live=1  &insight=<bi:insight:<id>>                        │
│        │                                                                │
│        ▼                                                                │
└────────┼─────────────────────────────────────────────────────────────────┘
         │  NETWORK BOUNDARY
┌────────▼─────────────────────────────────────────────────────────────────┐
│  /api/agent  (Vercel — may be a DIFFERENT instance than the feed)        │
│   resolveAnomaly: prefer ?insight= (client-carried) over getAnomaly(id)  │
│   stream NDJSON AgentEvents back ◀───────────────────────────────────────┤
└────────┼─────────────────────────────────────────────────────────────────┘
         │
┌────────▼─────────────────────────────────────────────────────────────────┐
│  BROWSER — reader loop drains stream → setItems/setDiagnosis live        │
│   `done` → stash bi:inv:diagnose:<id>                                    │
│          → if cDiag: stash bi:diag:<id> = { diagnosis }   (handoff)      │
│        │                                                                 │
│   "see recommendations →" ──▶ route to /investigate/<id>/recommend      │
│        ▼                                                                 │
│  STEP 3  useInvestigation(id, 'recommend')                              │
│   bi:inv:recommend:<id>? ──hit──▶ hydrate, RETURN                       │
│        │ miss                                                           │
│   read bi:diag:<id> → handedDiagnosis → setDiagnosis (context)          │
│   build url: …&step=recommend                                          │
│     live? += &diagnosis=<encode(JSON(handedDiagnosis))>  ──▶ /api/agent │
│   stream → recommendations → `done` → stash bi:inv:recommend:<id>       │
└──────────────────────────────────────────────────────────────────────────┘
```

The diagram stands alone: four `sessionStorage` keys (`bi:insight:`, `bi:inv:diagnose:`, `bi:inv:recommend:`, `bi:diag:`) are the only things that survive a route change or a cross-instance hop. The network boundary is crossed twice; each crossing is handed the state the server cannot remember on its own.

---

## Implementation in codebase

**File:** `lib/hooks/useInvestigation.ts`
**Function / class:** `useInvestigation` — the whole hook
**Line range:** L37–L216

Key landmarks (grepped):

- **Key builders** — `stashKey` (L18) builds `bi:inv:<step>:<id>`; `diagHandoffKey` (L19) builds `bi:diag:<id>`.
- **Started-guard** — `startedRef` declared L43; the two-line guard at L47–L48 (`if (startedRef.current) return;` / `startedRef.current = true;`).
- **No-cancel-on-cleanup rationale** — the comment block at L32–L36 states it explicitly: "we deliberately do NOT cancel the fetch on effect cleanup." The effect returns no cleanup function.
- **Hydrate-from-stash** — L50–L63 reads `bi:inv:<step>:<id>`, restores all four state slots, `setComplete(true)`, and `return`s before any fetch.
- **Closure mirrors** — `cItems`/`cDiag`/`cRecs` declared L65–L67; mutated alongside React state in every `handle` case (L97–L151).
- **Recommend-step diagnosis load** — L69–L84 reads `bi:diag:<id>` into `handedDiagnosis` and `setDiagnosis`.
- **Stash + handoff write on `done`** — L130–L144: stashes `bi:inv:<step>:<id>` (L133–L136) and, when `step === 'diagnose' && cDiag`, writes `bi:diag:<id>` (L138–L140).
- **Live-mode URL build** — L153–L168: appends `&live=1` (L159), reads `bi:insight:<id>` into `&insight=` (L160–L161), and (recommend step) appends `&diagnosis=` (L162–L164).
- **Reader loop** — L184–L208 (see `../02-dsa/03-ndjson-line-buffering.md` for the line-buffering mechanics).

**File:** `app/investigate/[id]/page.tsx`
**Function / class:** `InvestigatePage`
**Line range:** L33–L38, L149

Step 2's page calls `useInvestigation(id, 'diagnose')` (L38) — destructures `{ items, diagnosis, complete, error }`, omitting `recommendations` because step 2 does not run the recommendation agent. Renders `<InvestigationSubject id={id} />` (L149) for the subject card.

**File:** `app/investigate/[id]/recommend/page.tsx`
**Function / class:** `RecommendPage`
**Line range:** L32–L36, L145

Step 3 calls `useInvestigation(id, 'recommend')` (L36) — destructures all five slots including `recommendations`. The diagnosis it shows for context comes from the `bi:diag:<id>` handoff the hook reads internally. Also renders `<InvestigationSubject id={id} />` (L145).

**File:** `components/investigation/InvestigationSubject.tsx`
**Function / class:** `InvestigationSubject`
**Line range:** L11–L24

The consumer of the feed's insight handoff: reads `bi:insight:<id>` (L17), parses it into the subject card, and renders `null` (L24) if it is absent (e.g. a direct deep-link with no feed visit). The comment at L7–L10 documents that the feed writes this key in both demo and live.

**Server side (where the handoff lands):** `app/api/agent/route.ts` reads `?insight=` (L114), `?step=` (L117–L118), and `?diagnosis=` (L119); `resolveAnomaly` (L37) prefers the client-provided `?insight=` over its own in-memory `getAnomaly`; the recommend branch (L225–L228) parses `?diagnosis=` via `parseDiagnosis`.

**GitHub links:**
- `lib/hooks/useInvestigation.ts`: https://github.com/rlynjb/blooming_insights/blob/main/lib/hooks/useInvestigation.ts#L37-L216
- started-guard (L43–L48): https://github.com/rlynjb/blooming_insights/blob/main/lib/hooks/useInvestigation.ts#L43-L48
- handoff write (L130–L144): https://github.com/rlynjb/blooming_insights/blob/main/lib/hooks/useInvestigation.ts#L130-L144
- `components/investigation/InvestigationSubject.tsx`: https://github.com/rlynjb/blooming_insights/blob/main/components/investigation/InvestigationSubject.tsx#L11-L24

---

## Elaborate

**Where it comes from.** React 18 introduced the StrictMode double-invoke of effects in development to flush out effects that are not idempotent — effects that assume they run exactly once. The official guidance is to make every effect either repeatable (re-runnable with no harm) or cleanly cancellable. A `fetch` for data is the canonical "make it cancellable" case in the React docs: abort it in cleanup, the re-run re-fetches. This codebase makes the opposite choice — repeatable-by-guard rather than cancellable — because the fetch is a long NDJSON stream whose visible side effect (the live log) is the product, and aborting it shows the user nothing.

The `sessionStorage` handoff is the client-side mirror of server-side session state. React Query's `dehydrate`/`hydrate` and Next.js's `getServerSideProps`-to-client hydration solve the same "carry computed state across a boundary" problem; here the boundary is a client-side route change and a serverless instance switch, so the client's own `sessionStorage` is the carrier.

**The deeper principle.**

```
┌────────────────────────────────────────────────────────────────┐
│  Who can be trusted to remember state between two moments?      │
│                                                                 │
│  Moment pair                  │ Stateful?  │ Carrier needed     │
│  ─────────────────────────────┼────────────┼─────────────────── │
│  StrictMode run #1 → run #2   │ same fiber │ useRef latch       │
│  page A → page B (client nav) │ no         │ sessionStorage     │
│  feed req → investigate req   │ no (Vercel)│ sessionStorage→qs  │
│  agent step 2 → agent step 3  │ no         │ bi:diag → &diagnosis│
└────────────────────────────────────────────────────────────────┘
```

Every row where "Stateful?" is no needs an explicit carrier. The hook picks the cheapest carrier that survives that specific boundary: a ref for the in-process double-invoke, `sessionStorage` for navigation, a query param for the network hop.

**Where it breaks down.**

1. **`sessionStorage` is per-tab and ~5 MB.** Open the investigation in a new tab (middle-click the card) and `bi:insight:<id>` is not there — the new tab has its own `sessionStorage`. `InvestigationSubject` renders `null` and the live fetch falls back to the server-side `getAnomaly`, which misses on a fresh Vercel instance → "insight not found." Deep-links and new-tab opens are the failure surface.

2. **No stash invalidation.** `bi:inv:diagnose:<id>` lives for the tab's lifetime. If the underlying anomaly data changed (a fresh briefing recomputed it), the stash still serves the stale diagnosis — there is no TTL or version key. The user must close the tab to clear it.

3. **The started-guard defeats intentional re-runs.** Because the latch is keyed on the component instance, not on `(id, step)`, the only way to force a re-run within the same mount is a remount. The effect's dependency array is `[id, step]` (L213) — but the guard short-circuits before the dependencies are re-read, so changing `step` without remounting would not re-run. In practice `step` is fixed per page, so this never bites; it would if the hook were reused for a step-toggle in one component.

4. **`setState`-after-unmount relies on React 18+.** Pre-18 this logged a warning. The no-cancel pattern is clean only because React 18 silently drops post-unmount updates.

**What to explore next.**
- React Query / SWR with `staleTime` — replaces the manual `sessionStorage` stash with a managed cache and gives you invalidation and background refresh for free.
- `AbortController` keyed on `(id, step)` — a hybrid that cancels only on a real dependency change, not on StrictMode cleanup, by tracking whether the cleanup is the StrictMode one.
- The URL as the state carrier — pushing the diagnosis into the route (or a server-side session id) instead of `sessionStorage`, which would survive new-tab opens at the cost of URL length / a server round-trip.

---

## Interview defense

### What they are really asking

"Walk me through your data-fetching hook" is asking whether you understand why React StrictMode double-invokes effects, whether you know the difference between a cancellable subscription and a one-shot stream, and whether you have thought about where state lives when the backend is stateless (serverless) and the user navigates.

### Q + A

**[mid] How do you stop the agent from running twice in development?**

A `useRef` boolean latch — `startedRef`. The effect's first two lines are `if (startedRef.current) return;` then `startedRef.current = true;`. StrictMode runs the effect, runs cleanup, then runs the effect again on the same fiber; the ref keeps its value across that remount, so the second run returns immediately.

```
  effect run #1: startedRef false → set true → fetch
  cleanup:       (none registered)
  effect run #2: startedRef true → return
```

**[senior] Why not abort the fetch in the cleanup, like the React docs show?**

Because the fetch is a one-shot NDJSON stream whose live output is the product — the reasoning log the user watches. The React-docs cancel-on-cleanup pattern is correct for re-runnable queries: abort, then the re-run re-fetches. Here, StrictMode's cleanup would abort the only stream, and the guard would block the re-run from starting a fresh one, leaving the logs empty. So the hook guards instead of cancels and lets the in-flight stream complete; a `setState` after unmount is a no-op in React 18.

```
  cancel-on-cleanup:  run#1 opens → cleanup aborts → run#2 blocked → EMPTY
  guard, no-cancel:   run#1 opens → completes ✓   → run#2 returns
```

**[arch] On Vercel, how does the investigation know which anomaly to investigate if the feed ran on a different instance?**

The browser carries it. The feed stashes every insight in `sessionStorage` as `bi:insight:<id>`. When the investigation fires `/api/agent`, the hook reads that key and appends `&insight=<encoded>`. The server's `resolveAnomaly` prefers the client-provided `?insight=` over its own in-memory `getAnomaly(id)` — which is empty on a fresh instance. `sessionStorage` → query param is the cross-instance state channel; the diagnosis handoff (`bi:diag:` → `&diagnosis=`) works the same way for step 2 → step 3.

```
  instance A: feed → stash bi:insight:<id> (in browser)
  instance B: /api/agent ← &insight= ← browser
              resolveAnomaly: ?insight=  (present) ✓  not getAnomaly (empty)
```

### The dodge

**"Why `sessionStorage` instead of just React Query / a global store?"**

Honest answer: React Query solves the StrictMode dedupe and the per-step memo, but it does not by itself solve the two boundaries that actually hurt — a serverless instance switch and the agent-step-to-agent-step handoff. Both need state the *server* can read, and a client-side query cache is invisible to the server. So even with React Query I would still need a carrier into the request (a query param or a server session). `sessionStorage` + query params is the minimum that crosses both the client-nav boundary and the network boundary. The cost is no invalidation and no new-tab durability — which is the right trade for a single-session demo/live flow and the wrong one the moment deep-links matter.

### Anchors

- `lib/hooks/useInvestigation.ts` L47–L48 — the started-guard
- `lib/hooks/useInvestigation.ts` L32–L36 — the no-cancel-on-cleanup rationale
- `lib/hooks/useInvestigation.ts` L130–L144 — stash + diagnosis handoff on `done`
- `lib/hooks/useInvestigation.ts` L160–L164 — `&insight=` / `&diagnosis=` query-param encoding
- `components/investigation/InvestigationSubject.tsx` L17 — the `bi:insight:` consumer

---

## Validate your understanding

### Level 1 — reconstruct

Without looking at the code, draw the three storage tiers (`useRef`, `useState`, `sessionStorage`) and the four `sessionStorage` keys. For each key, name which boundary it survives (StrictMode remount, client route change, cross-instance request, or agent step→step). Then write the two-line started-guard from memory.

### Level 2 — explain

Open `lib/hooks/useInvestigation.ts`. Explain why the effect declares closure mirrors (`cItems`, `cDiag`, `cRecs`, L65–L67) in addition to the React state. Why can the `done` handler (L130–L144) not just stash `items` from state? What would go stale if it tried?

### Level 3 — apply

Scenario: a user opens `/investigate/abc123` directly (bookmark, no feed visit) in live mode. Walk the hook: does `bi:inv:diagnose:abc123` exist? Does `bi:insight:abc123` exist? What does the `&insight=` portion of the URL look like? When `/api/agent` calls `resolveAnomaly` and `?insight=` is absent, what does it fall back to and why might that miss? Cite `lib/hooks/useInvestigation.ts` L160–L161 and `app/api/agent/route.ts` L37. Then state what `InvestigationSubject` renders (cite `components/investigation/InvestigationSubject.tsx` L17–L24).

### Level 4 — defend

A reviewer says: "Cancelling the fetch in the effect cleanup is the standard React pattern — add an `AbortController`." Walk through exactly what breaks under StrictMode if you do (cite `lib/hooks/useInvestigation.ts` L32–L36 and L47–L48), and state without hedging why the guard-and-let-it-complete approach is correct for a one-shot stream and what the real cost of the no-cancel choice is.

### Quick check

- What type is `startedRef` and why not `useState`? (A `useRef<boolean>` — changing it triggers no re-render and it survives the StrictMode remount.)
- Name the four `sessionStorage` keys this flow uses. (`bi:insight:<id>`, `bi:inv:diagnose:<id>`, `bi:inv:recommend:<id>`, `bi:diag:<id>`.)
- Which key is read by `InvestigationSubject`? (`bi:insight:<id>` — `components/investigation/InvestigationSubject.tsx` L17.)
- In live mode, how does the step-3 recommendation agent receive the step-2 diagnosis? (The hook appends `&diagnosis=<encoded>` — `lib/hooks/useInvestigation.ts` L162–L164 — which the server parses in its recommend branch.)
- Does the effect register a cleanup function? (No — by design; L32–L36.)

## See also

→ 05-streaming-ndjson.md · → ../02-dsa/03-ndjson-line-buffering.md · → 01-request-flow.md
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
