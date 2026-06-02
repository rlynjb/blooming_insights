# Chapter 7 — The Counterfactuals

The strongest thing you can do in an interview is volunteer what you'd reconsider before anyone asks. It flips the dynamic: instead of the interviewer hunting for the weak decision and you defending it, you walk them to it yourself and show you already know the tradeoff. That reads as someone who's made a lot of decisions and lived with them — which is exactly what they're checking for.

But there's a trap on the other side, and it's just as fatal: manufacturing regret for decisions that were obviously right. If you "reconsider" using TypeScript or streaming over a fetch reader, you signal that you can't tell a real tradeoff from a settled one. So this chapter does two jobs. It names the three or four decisions in blooming insights that are genuinely reconsiderable and gives you the strong counterfactual for each — and it names, briefly, the calls you would *not* change, because knowing which is which is the whole skill.

```
┌ COUNTERFACTUALS MATRIX — what I decided vs. what I'd change, and why ────────────┐
│                                                                                  │
│ DECISION                  MODE              WOULD CHANGE WHEN…                    │
│ ───────────────────────── ───────────────── ──────────────────────────────────  │
│ in-memory state, no DB    deliberate        multi-user / multi-instance          │
│   (Map per Vercel inst.)  (for the context)   → shared store (Redis) + persisted │
│                                                 investigation store              │
│                                                                                  │
│ demo-replay = reliability evaluated-and-     upstream becomes stable             │
│   path (committed JSON)   accepted            → drop replay as the demo path,    │
│   for an alpha upstream                         keep it only as a fixture        │
│                                                                                  │
│ fixed ~1.1s call spacing  evaluated-and-     I have headroom + real traffic      │
│   (minIntervalMs 1100)    accepted            → token-bucket / adaptive limiter  │
│                                                 that uses the window better      │
│                                                                                  │
│ coverage deps = EXACT     deliberate (no     workspaces name events differently  │
│   event-name match        alias layer yet)    → normalization / alias layer in   │
│   (Set.has, no aliasing)                        schemaCapabilities                │
│                                                                                  │
│ ════════ WOULD NOT CHANGE (don't manufacture regret here) ════════              │
│ NDJSON over fetch reader · TypeScript · shared runAgentLoop abstraction          │
│ — settled calls; "reconsidering" these signals I can't tell a tradeoff from      │
│   a non-issue.                                                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

The right-hand column is the discipline: every reconsiderable decision has a *trigger condition* — the thing that would have to change for the counterfactual to win. A decision without a trigger isn't a tradeoff, it's an opinion. Let's walk them.

---

## Decision 1 — In-memory state, no database

┌──────────────────────────────────────────────────────────────────────────┐
│ Surface: where do you store state? Why no database?                         │
│ Probe:   did you choose no-DB on purpose and know its cost — or did you      │
│          just skip persistence because it was a hackathon?                  │
└──────────────────────────────────────────────────────────────────────────┘

This is a *deliberate* decision, and I say that word, because the honest framing is "right for the context, with a cost I can name." The context: a single upstream (one Bloomreach workspace), a demo, no multi-user requirement. State lives in in-memory maps — `lib/state/investigations.ts` keeps a `new Map<string, AgentEvent[]>` for cached investigations, and the auth/insights state is the same shape. There's no Postgres, no Redis, no vector store. For what this is, that's the correct amount of infrastructure.

The cost I'd name before they ask comes in two grades. The sharp one is a real correctness bug at modest concurrency: `lib/state/insights.ts` line 4 is a *global* `Map` per Vercel instance, and `putInsights` line 36 calls `insights.clear()` at the top of every briefing write. For one user that's correct (each run *is* the current feed, not an addition). For two users on the same warm instance it isn't — A's briefing wipes B's mid-session. ~30 LOC of session-keying (`Map<sessionId, Map<id, Insight>>`, threaded through `getOrCreateSessionId`) fixes it with no new infrastructure. The broader one is per-instance state in general: a cold start re-bootstraps the schema from scratch, and an investigation cached on instance A isn't visible to a request that lands on instance B. There's a dev-file fallback (`.investigation-cache.json`) and a committed demo seed, but the live in-memory cache is not shared across instances. For a single demo user that's invisible; for real multi-user traffic it would mean inconsistent cache hits and repeated bootstraps.

So here's the counterfactual, in two steps with two triggers. *The day this has any concurrent users* (even on one warm instance), I session-key the `insights` Map — that's the ~30 LOC fix, no infra, eliminates the wipe bug. *The moment I'm multi-instance or need to survive instance churn*, I add a shared store — Redis for the hot cache (the 60s tool-result cache and the bootstrap schema) and a persistent investigation store so a completed investigation is durable and shareable, not stranded on the instance that ran it. I would not add either preemptively; adding infrastructure I don't yet need is its own kind of mistake.

┃ "No database was deliberate, not lazy. The cost is per-instance state — cold starts re-bootstrap, and an investigation cached on one instance isn't visible to another. At multi-user scale I'd add Redis plus a persistent investigation store."

┌─ STRONG vs WEAK — "why no database?" ──────────────┬───────────────────────────────┐
│ WEAK                                                │ STRONG                         │
├─────────────────────────────────────────────────────┼───────────────────────────────┤
│ "It's just a demo so I didn't really need a         │ "Deliberate. Single upstream,  │
│  database, I could add one later if I needed to."    │  one demo user — in-memory     │
│                                                      │  maps are the right size. The  │
│                                                      │  cost is per-instance state:   │
│                                                      │  cold starts re-bootstrap,     │
│                                                      │  cache isn't shared. At        │
│                                                      │  multi-user I'd add Redis +    │
│                                                      │  a persistent investigation    │
│                                                      │  store."                       │
├─────────────────────────────────────────────────────┼───────────────────────────────┤
│ Why it's weak: "didn't really need" sounds like you │ Why it works: names the mode   │
│ avoided the work. "Later if I needed to" has no      │ (deliberate), the cost          │
│ trigger and no cost. Sounds like an excuse.          │ (per-instance), and the trigger│
│                                                      │ (multi-user) with a concrete   │
│                                                      │ next step.                     │
└─────────────────────────────────────────────────────┴───────────────────────────────┘

### Follow-up decision tree

```
"Why no database?"  → (deliberate, single upstream)
   │
   ├─ "What breaks first when you add a second user?"
   │     └─► "Cache coherence. Two users hitting different instances see
   │          different cached investigations and each triggers its own
   │          bootstrap. First fix is a shared cache — Redis — so the 60s
   │          tool-result cache and the schema are shared."
   │
   ├─ "Why not just add the DB now to be safe?"
   │     └─► "Infra I don't need is a liability — another thing to provision,
   │          secure, and keep in sync. For one upstream and one demo user the
   │          map is correct. I add the store when there's a user to serve with
   │          it."
   │
   └─ "How would you make a completed investigation durable?"
         └─► "A persistent investigation store keyed by insight id — the cache
              already produces a replayable AgentEvent[] per investigation, so
              I'd persist that array and the demo seed shows the shape already
              works for replay."
```

---

## Decision 2 — Demo-replay as the reliability path

┌──────────────────────────────────────────────────────────────────────────┐
│ Surface: why is there a whole demo mode that replays a JSON file?           │
│ Probe:   is this a real product feature or a workaround you're dressing up  │
│          as one — and do you know which?                                    │
└──────────────────────────────────────────────────────────────────────────┘

I'm going to call this honestly: demo-replay is *evaluated-and-accepted*, and it's a workaround for an unstable upstream, not a product feature. I say that plainly because dressing a workaround up as a feature is exactly the bluff the probe is hunting for.

The constraint that drove it: the loomi connect MCP server is alpha. It revokes tokens after minutes and rate-limits to roughly one request per second per user, globally. That makes a live agent run a fragile thing to stand on stage with — the token can die mid-investigation. So I built a demo mode (`localStorage` `bi:mode`, default demo) that replays a committed snapshot — `lib/state/demo-insights.json` and `demo-investigations.json` — as a *paced NDJSON stream*, so the presentation path is creds-free and reliable and looks exactly like a live run. The briefing route's demo branch reads the JSON and re-emits it event-by-event at `REPLAY_DELAY_MS`; the agent route does the same for investigations, filtered to the requested step. It's clever for the constraint, and I'm glad it exists, but I won't pretend the value is the replay itself.

The counterfactual and its trigger: *if the upstream were stable* — durable tokens, a sane rate limit — I'd make live the default and demote replay to what it actually is, a fixture for tests and offline development. The replay code is genuinely useful as a deterministic fixture (it's how the UI gets exercised without a network), so I wouldn't delete it; I'd stop using it as the *reliability* path and let live carry the demo.

What makes the answer strong is that I'm not claiming I designed a beautiful offline mode for its own sake. I'm saying: the upstream forced a recovery-oriented design, I met it with a paced replay, and the day the upstream is stable that crutch comes out.

┃ "Demo-replay is a workaround for an alpha server that revokes tokens after minutes, not a feature. If the upstream were stable I'd default to live and keep the replay only as a test fixture."

▸ The replay isn't fake data dressed as live — it's a real captured snapshot of a real run, re-streamed at a readable pace. That's the part I'm comfortable defending; the part I won't oversell is calling it a feature.

### Follow-up decision tree

```
"Why replay a JSON file instead of running live?"  → (alpha upstream)
   │
   ├─ "So the demo isn't real?"
   │     └─► "The snapshot is a real captured run — real schema, real EQL,
   │          real insights. Replay re-streams it creds-free so a token
   │          revocation mid-demo can't kill the presentation. Live mode runs
   │          the agents for real; it's one localStorage flag away."
   │
   ├─ "Isn't that hiding that the live path is broken?"
   │     └─► "The live path works — I've run it. It's fragile because the
   │          upstream is alpha, not because my code is broken. The briefing
   │          route returns honest 401/500s live; replay is the path I trust
   │          on a stage, not the only path that works."
   │
   └─ "What changes if the upstream stabilizes?"
         └─► "Live becomes the default mode, replay drops to a test fixture. I
              don't rewrite anything — I flip the default and keep the snapshot
              for deterministic UI tests."
```

---

## Decision 3 — Fixed ~1.1s inter-call spacing

┌──────────────────────────────────────────────────────────────────────────┐
│ Surface: how do you handle the upstream rate limit?                         │
│ Probe:   do you understand the limiter you built, and can you name a better │
│          one without pretending the simple one was a mistake?               │
└──────────────────────────────────────────────────────────────────────────┘

This is *evaluated-and-accepted*: I picked the simple fixed interval on purpose, knowing it's conservative. `McpClient` enforces `minIntervalMs: 1100` between live calls (`lib/mcp/client.ts`, configured in `connect.ts`) — every call waits until at least 1.1 seconds have passed since the last one. On top of that there's a 60s response cache so repeats don't hit the network, and a retry path that parses the server-stated penalty window from the 429 text and waits it out (`retryDelayMs` 10s fallback, `retryCeilingMs` 20s cap, `maxRetries` 3).

The honest assessment: a fixed interval is conservative. It paces every call at 1.1s regardless of whether I have budget headroom — if I've made no calls for ten seconds, the next one still waits its 1.1s floor isn't quite right (the floor is measured against the *last* call, so an idle gap doesn't cost extra), but the deeper point stands: a fixed minimum interval can't *spend* accumulated headroom. A token-bucket or adaptive limiter would let me burst up to the window's real allowance and only throttle when I'm actually near the limit, using the budget better — which matters because the agent route has a hard time budget and every forced wait eats into it.

Why I accepted the simple version anyway, and this is the real defense: against an alpha limit that's been observed as *both* "1 per 1 second" and "1 per 10 second," a fixed conservative interval is predictable and won't get me throttled in a way a tuned bucket might if I mis-modeled the window. The connect.ts comment is explicit that spacing at the full 10s window would blow the route's time budget, so 1.1s is the chosen middle: proactive enough to mostly avoid 429s, fast enough to fit a multi-call investigation in budget, with the parsed-retry path as the backstop when a 429 does land. The counterfactual — a token bucket — wins *when I have stable rate-limit headroom and real traffic to optimize for*, neither of which an alpha demo has.

I would *not* claim the fixed interval is wrong. I'd claim it's the right call for an unstable, ambiguous limit, and that I know exactly what I'd reach for once the limit is known and stable.

╔══════════════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY BOX — pushed on the exact backoff math                 ║
║                                                                                ║
║ The pushback: "Why 1.1 seconds and not 1.0 or 1.5? Why a 20s ceiling? Justify  ║
║               the numbers."                                                     ║
║                                                                                ║
║ Say: "I'm not going to pretend those are tuned to an optimum — they're not.    ║
║      1.1s is a small cushion over the observed 1-per-second window so I clear   ║
║      it without racing the boundary; the 20s ceiling caps any single retry     ║
║      wait so a slow penalty can't blow the route's time budget. They're        ║
║      conservative defaults for an alpha limit I can't fully characterize, not  ║
║      values I derived from a model. With real traffic I'd measure the 429 rate ║
║      and tune them, or move to a token bucket."                                 ║
║                                                                                ║
║ What this signals: you know which of your numbers are principled and which are ║
║      reasonable guesses, and you don't dress a guess up as math.               ║
║                                                                                ║
║ Do NOT say: "1.1 is optimal because…" and invent a derivation. There isn't     ║
║      one in the code — it's a cushion over an observed window — and a fake     ║
║      derivation is the easiest bluff in the room to catch.                     ║
╚══════════════════════════════════════════════════════════════════════════════╝

┃ "Fixed 1.1-second spacing is conservative on purpose — for an alpha limit observed as both 1-per-1s and 1-per-10s, predictable beats clever. A token bucket wins once the window is known and stable."

### Follow-up decision tree

```
"Why a fixed interval and not a token bucket?"  → (evaluated-and-accepted)
   │
   ├─ "A bucket would be faster — why not just do that?"
   │     └─► "It would, when I have headroom to spend. But it needs a known,
   │          stable window to size the bucket. The alpha limit reports two
   │          different windows, so a bucket sized wrong gets me throttled. The
   │          fixed floor can't burst, but it can't mis-burst either."
   │
   ├─ "What does the retry path do when you DO get rate-limited?"
   │     └─► "Parses the stated window out of the 429 text — it says '1 per 10
   │          second' — and waits that out plus a buffer, capped at 20s, up to
   │          3 retries. Errors don't get cached, so a throttled call retries
   │          clean."
   │
   └─ "How would you know the fixed interval is costing you?"
         └─► "Measure the 429 rate and the idle time between calls. If 429s are
              near zero and I'm leaving window unused, I'm too conservative and
              a bucket would reclaim it."
```

---

## Decision 4 — Coverage deps couple to exact event names

┌──────────────────────────────────────────────────────────────────────────┐
│ Surface: how does the coverage gate decide a category is supported?         │
│ Probe:   do you see the brittleness in your own gate — that it'll misfire   │
│          on a workspace that names things slightly differently?             │
└──────────────────────────────────────────────────────────────────────────┘

This one I volunteer as a real limitation, and it's *deliberate* in the sense that I built it knowing it has no alias layer — I just didn't need one for the workspace I targeted. The coverage gate in `lib/agents/categories.ts` declares each category's dependencies as exact event-name strings — `conversion_drop` requires `['view_item', 'checkout', 'purchase']` — and `coverageFor()` checks them with a plain `available.has(dep)` against a `Set` built from the live schema. Exact string match, no normalization.

The brittleness, stated plainly: a workspace that emits `product_view` instead of `view_item`, or `order_completed` instead of `purchase`, reads as *unavailable* — the category ghosts out even though the data is right there under a different name. The gate is honest (it won't fake a category), but it's honest about the *literal* names, not the semantic ones. For the demo workspace the names matched the registry, so it never bit me; for an arbitrary Bloomreach workspace it would.

The counterfactual, with its trigger: *the moment this runs against workspaces I don't control*, I'd add a normalization/alias layer in `schemaCapabilities` — a mapping from canonical category deps to the workspace's actual event names, either a static alias table (`purchase` ← `order_completed`, `transaction`…) or a light LLM-assisted match at bootstrap that proposes mappings a human confirms. That keeps the gate's honesty — it still won't fake a missing capability — while stopping it from misfiring on a naming difference. I'd put it at the capability-set construction so the rest of the gate logic stays a pure exact-match function and only the *input* set gets enriched with aliases.

The reason I frame it as deliberate-but-limited rather than a bug: for a single known workspace, exact match is simpler and has zero false positives — it never claims a capability the workspace doesn't have. The alias layer adds a place to be *wrong* (a bad alias claims a capability that isn't really equivalent). So I'd add it only when the multi-workspace need is real, and I'd make the aliases explicit and auditable, not magic.

┃ "The gate matches event names exactly — `Set.has`, no aliasing. It's honest about literal names, so a workspace that calls it `order_completed` instead of `purchase` ghosts the category. The fix is an alias layer at capability-set construction, added when I'm running against workspaces I don't control."

┌─ STRONG vs WEAK — owning the alias gap ────────────┬───────────────────────────────┐
│ WEAK                                                │ STRONG                         │
├─────────────────────────────────────────────────────┼───────────────────────────────┤
│ "The coverage gate is pretty robust, it checks the  │ "It's exact event-name match — │
│  schema before running anything."                    │  no alias layer. So a          │
│                                                      │  workspace that names purchase │
│                                                      │  'order_completed' ghosts the  │
│                                                      │  category. Honest about        │
│                                                      │  literal names, brittle about  │
│                                                      │  semantic ones. I'd add a      │
│                                                      │  normalization layer for       │
│                                                      │  workspaces I don't control."  │
├─────────────────────────────────────────────────────┼───────────────────────────────┤
│ Why it's weak: "pretty robust" hides the exact-      │ Why it works: names the        │
│ match brittleness — the one thing the probe is       │ mechanism, the failure mode,   │
│ testing whether you see. Sounds like you don't.      │ and the scoped fix with its    │
│                                                      │ trigger. You saw it first.     │
└─────────────────────────────────────────────────────┴───────────────────────────────┘

### Follow-up decision tree

```
"How does the gate decide a category is supported?"  → (exact event-name match)
   │
   ├─ "What happens if the event is named differently?"
   │     └─► "It ghosts — reads as unavailable. The gate is honest about the
   │          literal names in the schema, not semantic equivalents. That's the
   │          brittleness, and I'd fix it with an alias layer."
   │
   ├─ "Where would the alias layer go?"
   │     └─► "In schemaCapabilities, where I build the available-capability Set.
   │          I'd enrich that Set with aliases so the rest of the gate stays a
   │          pure exact-match function — only the input changes."
   │
   └─ "Why not just fuzzy-match every event name?"
         └─► "Fuzzy matching adds false positives — claiming a capability the
              workspace doesn't really have, which breaks the honesty the gate
              exists for. I'd use an explicit, auditable alias table or a
              human-confirmed mapping, not silent fuzzy matching."
```

---

## The decisions I would NOT change

This is the other half of the skill, and I say it crisply so I don't drift into manufactured regret. Three calls were right and I'd make them again:

- **NDJSON over a fetch + ReadableStream reader, not EventSource.** I'm already doing a fetch; reading newline-delimited JSON off the body is the entire client, one `JSON.parse` per line. SSE would add framing, GET-only constraints, and auto-reconnect I don't want mid-investigation. Settled.
- **TypeScript.** The whole system is type-driven — the `AgentEvent` contract, the `Diagnosis`/`Recommendation` shapes, the injected `McpCaller` interface that lets the 169-test suite (18 files) run with fakes and no network. Reconsidering this would be reconsidering the thing that makes the tests possible.
- **The shared `runAgentLoop` abstraction.** One tool-use loop in `base.ts` drives all four agents — monitoring, diagnostic, recommendation, query — with the same budget, forced-synthesis, and error-handling behavior. Four copies of that loop would be four places to fix the next bug. Settled.

Naming these as non-issues is deliberate: if I "reconsidered" them, I'd be telling you I can't distinguish a real tradeoff from a non-issue, which is the worst signal I could send in a chapter about judgment.

╔══════════════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY BOX — "isn't every decision a tradeoff?"               ║
║                                                                                ║
║ The pushback: "Surely you'd reconsider NDJSON or the shared loop too — name a  ║
║               downside."                                                        ║
║                                                                                ║
║ Say: "I can name a theoretical downside for anything, but I won't pretend it's ║
║      a live tradeoff when it isn't. NDJSON-over-fetch and the shared loop are  ║
║      settled for this system — the alternatives cost more for no payoff here.  ║
║      The decisions genuinely worth reconsidering are the four I led with: the  ║
║      DB, the replay path, the fixed limiter, and the exact-match coverage      ║
║      deps. I'd rather spend the time on the real ones."                        ║
║                                                                                ║
║ What this signals: you can tell a settled call from an open one and you won't  ║
║      manufacture regret to look humble. That's senior judgment.                ║
║                                                                                ║
║ Do NOT say: "Yeah, maybe I'd switch to SSE…" to seem agreeable. Inventing a    ║
║      reconsideration for a right call reads as not understanding why it was    ║
║      right.                                                                     ║
╚══════════════════════════════════════════════════════════════════════════════╝

---

## What you'd change

Across these four, the single change I'd make first is even smaller than the alias layer: the ~30 LOC session-key on `lib/state/insights.ts`. It fixes a real correctness bug at any current scale (the `putInsights.clear()` wipe of a concurrent user on one warm instance), needs no new infrastructure, and the session id is already in scope. The alias/normalization layer for coverage deps is the next-cheapest — clearest trigger (a second workspace), fix contained to `schemaCapabilities`. The bigger DB and the limiter wait on scale or stable traffic I don't have yet, and the demo-replay waits on the upstream stabilizing — none of those are worth building speculatively. The honest through-line is that every one of these was the right call *for an alpha, single-upstream demo*, and each has a named trigger that flips the decision. That's the posture I'd want them to walk away with: not that I got everything right, but that I know precisely what would have to change for each call to be wrong.

---

## One-page summary — Chapter 7

**Core claim:** I can volunteer the four genuinely reconsiderable decisions in this system, give the counterfactual and the trigger for each, and — just as importantly — name the calls I would NOT change without manufacturing regret.

| Decision | Mode | One-line counterfactual |
|---|---|---|
| In-memory state, no DB | deliberate | Per-instance cache + cold-start re-bootstrap; add Redis + a persistent investigation store at multi-user scale. |
| Demo-replay = reliability path | evaluated-and-accepted | A workaround for an alpha server that revokes tokens; default to live and demote replay to a fixture once the upstream is stable. |
| Fixed ~1.1s call spacing | evaluated-and-accepted | Conservative on purpose for an ambiguous limit; a token bucket wins once the window is known and I have headroom. |
| Coverage deps = exact event names | deliberate (no alias yet) | A differently-named workspace ghosts categories; add a normalization/alias layer in `schemaCapabilities` for workspaces I don't control. |
| **Would NOT change** | — | NDJSON-over-fetch · TypeScript · the shared `runAgentLoop` — settled calls, not tradeoffs. |

**Pull quotes:**
- "No database was deliberate, not lazy — the cost is per-instance state, and at multi-user scale I'd add Redis plus a persistent investigation store."
- "Demo-replay is a workaround for an alpha server that revokes tokens, not a feature."
- "Fixed 1.1-second spacing is conservative on purpose — for a limit observed as both 1-per-1s and 1-per-10s, predictable beats clever."
- "The gate matches event names exactly, so a workspace that calls it `order_completed` instead of `purchase` ghosts the category — the fix is an alias layer."

**The "what you'd change" sentence:** Session-key `lib/state/insights.ts` first (~30 LOC, fixes the concurrent-user clear-wipe with no infra), then add the coverage alias layer, then leave the DB, limiter, and replay decisions until scale, stable traffic, or a stable upstream actually arrives.

---
Updated: 2026-05-29 — created
Updated: 2026-06-02 — Test-count precision (~170 → 169 tests across 18 files); incorporated the CRITICAL `lib/state/insights.ts` race condition (global `Map` + `putInsights.clear()` wipes a concurrent user on one warm instance) into Decision 1 in two grades — the ~30 LOC session-key fix is now the lead "what you'd change" before the alias layer, per study-system-design audit's red-flags ranking.
