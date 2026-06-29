# Chapter 7 — The counterfactuals

  ## Opening hook

The senior-engineer move on this question is to volunteer what you'd reconsider before being asked. It signals two things at once: you're not romantically attached to your own decisions, and you've actually thought about which ones have the highest revisit value. Junior engineers defend everything. Senior engineers defend the load-bearing things and volunteer the rest.

This is also the chapter most likely to backfire. The trap is fabricating regrets for decisions that were obviously right. "Oh I wish I hadn't used TypeScript" is the wrong answer — not because someone might believe you, but because the interviewer hears a candidate who can't tell the difference between a load-bearing decision and a settled one. The strong shape is a *would-not-change list* up front (so they know your baseline is grounded) followed by the *four real reconsiderations* with each one's trigger named.

  ## The picture you draw — the counterfactuals matrix

```
  Counterfactuals — what stays, what you'd revisit, what triggers the revisit

  ┌─ WOULD NOT CHANGE (the receipts) ──────────────────────────────────────┐
  │  NDJSON over fetch + shared readNdjson kernel                          │
  │     → receipt: same kernel powers 4 streaming surfaces today           │
  │  TypeScript                                                            │
  │     → receipt: the type surface caught the schema drift on each       │
  │       MCP unwrap change                                                │
  │  DataSource seam + adapter pattern                                     │
  │     → receipt: survived 2 adapter swaps without changing caller        │
  │       surface — that's the receipt, not future-proofing                │
  │  AptKit primitive boundary                                             │
  │     → receipt: library owns the loop, I own the boundary,             │
  │       legacy preserved at base-legacy.ts:86-176                        │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ WOULD RECONSIDER (with trigger) ──────────────────────────────────────┐
  │                            │                                            │
  │  decision                  │  trigger that flips it                     │
  │  ──────────────────────────┼──────────────────────────────────────────  │
  │  1. No DB (cross-instance  │  Vercel runs more than one warm instance  │
  │     state remains open)    │  in rotation for the same user             │
  │                            │                                            │
  │  2. Demo-replay as the     │  the alpha Bloomreach server's token       │
  │     reliability path        │  lifetime extends past the briefing       │
  │                            │  duration AND rate limits stabilize        │
  │                            │                                            │
  │  3. Fixed ~1.1s call       │  measured rate-limit headroom AND a real   │
  │     spacing (Bloomreach)   │  metric showing some users blocked         │
  │                            │  by the floor                              │
  │                            │                                            │
  │  4. Tool-coverage deps as  │  a second workspace that uses different    │
  │     exact event-name match │  event naming for the same concepts         │
  └────────────────────────────────────────────────────────────────────────┘
```

Four reconsiderations. Each one has a trigger. The trigger is the senior signal — it shows the decision isn't "I'd reconsider this someday" but "I'd reconsider this *when* X."

  ## The body — would-not-change first, then the four reconsiderations

  ### The would-not-change list (volunteered up front)

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "What would you do differently if you were starting       │
  │    today?"                                                   │
  │                                                              │
  │ WHAT THEY'RE TESTING                                         │
  │   Will you fabricate regrets to sound humble, or will you   │
  │   distinguish settled decisions from open ones? Can you     │
  │   defend the things that stay AND name the things that      │
  │   change?                                                    │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer (the opener — volunteer the would-not-change list first):**

> "Four things I'd keep exactly as they are, and then four I'd reconsider.
>
> What I'd keep: the NDJSON streaming contract with a single shared `readNdjson` kernel — the receipt is that one kernel powers four streaming surfaces in the app today (briefing, investigation, demo capture, tests) and the contract has held across every refactor. TypeScript — every MCP unwrap change shifted the type surface and that surface caught the drift before runtime. The DataSource seam with its adapter pattern — the receipt isn't future-proofing, it's that the seam *already survived* two adapter swaps without changing what the agents call. And the AptKit primitive boundary — three small adapter classes, library owns the loop, I own the boundary, legacy hand-rolled loop preserved at `lib/agents/base-legacy.ts:86-176` as a rollback receipt.
>
> Now the four I'd reconsider — and each has a specific trigger."

```
  ┃ "I'm not future-proofing for a swap I haven't done.
  ┃  I've done two. The seam is paid for."
```

  ### Reconsideration 1 — no database (cross-instance state)

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "You really wouldn't add a database?"                     │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you understand that the right architecture today is    │
  │   not always the right architecture tomorrow? Can you name  │
  │   the trigger that flips the call?                          │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "Today, no. The data the user cares about historically lives in Bloomreach already — I'm not building a system of record, I'm reading one. Briefings are ephemeral. Cross-session state was a real concern and I addressed it the right way at the right time: when I had a concurrent-user bug in `lib/state/insights.ts` — module-level Map with `clear()` wiping other users mid-briefing — I session-keyed the map. That bug is resolved.
>
> What's still open is cross-instance state. If Vercel adds a second warm instance to the rotation for the same user, their session state doesn't follow them across instances. The trigger to add a database is exactly that: a second warm instance in the rotation. At one warm instance the in-memory model is correct and any database is overhead I'm paying for nothing. At two it stops being correct.
>
> When the trigger fires, the change is bounded. The session-keyed maps already isolate per-user state — moving them behind a key-value store with the same `sessionId` keys is mostly an adapter swap, conceptually the same move as `BloomreachDataSource` to `SyntheticDataSource`."

  ### Reconsideration 2 — demo-replay as the reliability path

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Demo mode is the default — that's weird for a real app.  │
  │    Why?"                                                    │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you have a real reason for the default, or is it       │
  │   hiding from a problem? Can you name what would flip       │
  │   the default?                                              │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "Demo is the default because the alpha Bloomreach server isn't a presentation-grade dependency. Tokens revoke in minutes; the server occasionally 500s; the rate limit is shared. For a presentation, a demo, or anyone who wants to see what the app *does*, live mode is hostile.
>
> The committed demo snapshot solves this honestly: `lib/state/demo-*.json` is a real captured run — real agent output, real tool calls, real numbers — that any instance can serve instantly as plain JSON. Cards, logs, comparison bars, recommendations all render from real data. Where a field wasn't captured at capture time, the UI shows `--`, not a fake.
>
> The trigger to flip the default to live is when the alpha server's token lifetime is longer than a typical briefing AND the rate limit doesn't degrade under realistic concurrent load. Both are upstream changes, not changes I can make. Until then, demo-first is the right default."

```
  ┌─────────────────────────┬─────────────────────────────────┐
  │ WEAK ANSWER             │ STRONG ANSWER                   │
  ├─────────────────────────┼─────────────────────────────────┤
  │ "Yeah I'd love to make  │ "Demo is the default because    │
  │  live the default but   │  the alpha server isn't         │
  │  it's flaky right now." │  presentation-grade — tokens    │
  │                         │  revoke in minutes, rate limit  │
  │                         │  is shared. Trigger to flip:    │
  │                         │  upstream auth lifetime extends │
  │                         │  past a briefing AND rate limit │
  │                         │  stays stable under load."      │
  ├─────────────────────────┼─────────────────────────────────┤
  │ Why it's weak: "flaky"  │ Why it works: names what's     │
  │ is a feeling. Doesn't   │ specifically wrong about the    │
  │ name the specific       │ upstream, names the conditions  │
  │ constraint or what       │ that would flip the decision,  │
  │ would change it.        │ and owns the design today.     │
  └─────────────────────────┴─────────────────────────────────┘
```

  ### Reconsideration 3 — fixed ~1.1s call spacing

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Why a fixed 1.1-second floor between Bloomreach calls?   │
  │    Why not exponential backoff or token-bucket?"            │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you understand the rate-limit shape you're working     │
  │   against? Did you measure or did you guess? When would     │
  │   you tune it?                                              │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "The ~1.1s spacing in `BloomreachDataSource` is a conservative floor I picked based on the alpha server's documented 'roughly one request per second' soft limit, with a safety margin to avoid skating the edge of the 429. The retry-on-429 in `McpClient` is the second layer if the floor proves wrong on a given call.
>
> I didn't measure the actual headroom. I guessed conservatively and it works — which is fine for an alpha substrate, but it's a guess. The trigger to revisit is two things together: an actual measurement of rate-limit headroom (how close to the boundary the server lets me skate before 429s start), AND a real metric showing some users are blocked by the 1.1s floor itself rather than by the server.
>
> Today neither is true. The 1.1s floor is well within the budget; the briefings that feel slow feel slow because of *number* of tool calls, not pacing of each. So I'd revisit on measurement, not on impulse."

  ### Reconsideration 4 — exact-match tool-coverage dependencies

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Your tool-coverage map depends on exact event-name        │
  │    matches. What happens on a second workspace?"             │
  │                                                              │
  │ WHAT THEY'RE TESTING                                         │
  │   Have you thought about generalizing past the one workspace │
  │   you built against? Or have you hard-coded yourself in?    │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "Today, tool-coverage in `lib/mcp/tool-coverage.ts` checks for specific Bloomreach event names — `purchase`, `view_item`, `cart_update`, `checkout`, `session_start`. These are the events the current workspace exposes; the agents depend on them; the coverage grid in the UI tells the user which categories are diagnosable.
>
> The gap is: if I dropped this app onto a second Bloomreach workspace with the same conceptual events under different names — say `order_placed` instead of `purchase` — the coverage grid silently goes red for events the workspace actually has. The agent then refuses to investigate a category it could have handled.
>
> The fix is an alias layer: each agent-conceptual dependency maps to a set of acceptable workspace-actual names. The trigger to do this work is a second workspace. Today I have one workspace and shipping the alias layer would be speculative abstraction — the same mistake I'd be calling out elsewhere. The seam where the alias would land is already isolated, so when the second workspace appears the change is bounded to one file."

```
  ┃ "Speculative abstraction is the same mistake at both
  ┃  ends — building the seam too early is as wrong as
  ┃  never building it. The trigger names the right moment."
```

  ## When you don't know

The trap on this chapter is being asked about a counterfactual you *should* have considered but didn't think to volunteer — an entirely different shape of the system the interviewer thinks you should have weighed.

```
  ╔═══════════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                           ║
  ║                                                               ║
  ║   They ask: "Would you have considered building this as a     ║
  ║   chat agent — one conversation, the agent decides which      ║
  ║   step (monitor / diagnose / recommend) to run next?"         ║
  ║                                                               ║
  ║   You did not seriously evaluate a single-agent conversational║
  ║   shape against the three-agent pipeline shape you built.     ║
  ║   You'd be guessing if you claimed to have weighed it.        ║
  ║                                                               ║
  ║   Say:                                                        ║
  ║   "I didn't seriously evaluate a single-conversation agent    ║
  ║    shape against the three-agent pipeline. I picked the       ║
  ║    pipeline because the user flow already had three           ║
  ║    distinct stages — monitor, investigate, decide — and       ║
  ║    each maps cleanly to one agent with its own prompt and     ║
  ║    its own output schema. A single chat agent would have      ║
  ║    needed routing logic the user couldn't see, which          ║
  ║    contradicts the 'show your work' product premise. But      ║
  ║    that's a post-hoc defense — I didn't put both shapes       ║
  ║    side-by-side at decision time. If you want to walk what   ║
  ║    that comparison would look like, I'd be doing it on the   ║
  ║    whiteboard with you, not from memory."                     ║
  ║                                                               ║
  ║   What this signals: honesty that you didn't run the          ║
  ║   counterfactual at decision time, a real post-hoc defense    ║
  ║   anchored to the product premise, willingness to do the      ║
  ║   analysis in the room rather than confabulating one.         ║
  ║                                                               ║
  ║   Do NOT say:                                                 ║
  ║   "I considered both and the pipeline was clearly better      ║
  ║    because..." — fabricating a decision process you didn't    ║
  ║   actually run is the worst move. Senior interviewers know   ║
  ║   what real evaluation looks like and will probe.            ║
  ╚═══════════════════════════════════════════════════════════════╝
```

  ## What you'd change about the counterfactuals chapter itself

If you were redoing how you *think about* counterfactuals on this project, the change you'd make is **logging the trigger conditions explicitly**, somewhere checked into the repo. Right now the triggers — "two warm instances," "stable upstream rate limit," "second workspace" — live in your head. The fix is a one-page `TRIGGERS.md` next to the counterfactuals, so the next maintainer (or you, six months later) doesn't have to rediscover them. The cost is one more doc to keep current. The payoff is a senior-team-shaped artifact: decisions with explicit revisit conditions.

  ## One-page summary

**Core claim:** the senior move is to volunteer the would-not-change list first (so the interviewer knows your baseline is grounded), then walk four real reconsiderations each with a specific trigger. Decisions don't have abstract regrets; they have conditions that would flip them.

**Would not change:** NDJSON + shared `readNdjson` kernel (receipt: powers 4 surfaces); TypeScript (receipt: caught schema drift); DataSource seam (receipt: survived 2 adapter swaps); AptKit primitive boundary (receipt: legacy preserved as rollback).

**Would reconsider (with trigger):**
1. *No DB* → trigger: a second warm Vercel instance for the same user. Cross-instance state remains open; the concurrent-user wipe is resolved.
2. *Demo-replay as reliability path* → trigger: alpha server's auth lifetime extends past briefing duration AND rate limit stabilizes.
3. *Fixed ~1.1s call spacing* → trigger: measured rate-limit headroom AND a metric showing users blocked by the floor.
4. *Exact-match tool-coverage deps* → trigger: a second workspace with different event naming for the same concepts.

**Pull quotes:**
```
┃ "I'm not future-proofing for a swap I haven't done.
┃  I've done two. The seam is paid for."
```
```
┃ "Speculative abstraction is the same mistake at both
┃  ends — building the seam too early is as wrong as
┃  never building it. The trigger names the right moment."
```

**What you'd change:** check the trigger conditions into the repo as `TRIGGERS.md`, so the revisit conditions are explicit rather than living in your head.
