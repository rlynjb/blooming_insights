# Chapter 6 — The Hard Parts

This is the chapter where the interview stops being about the system and starts being about you. The questions are simple — "what was the hardest bug?", "what part are you proudest of?", "what's the part you're least sure about?" — and they are the ones that separate people who built something from people who narrated something. The trap is treating the third one as a confession. It isn't. The person across the table already knows you have gaps; what they're measuring is whether you know where your gaps are and can stand on the edge of one without falling in.

So this chapter teaches you to do three things on demand: walk a real bug from symptom to insight to fix, name the thing you're proudest of without inflating it, and point at the part of your own codebase you understand least — and own it so cleanly that it reads as senior signal instead of a hole. Start by getting honest about the terrain.

```
┌ CONFIDENCE MAP — blooming insights, by how hard you can defend it ──────────────┐
│                                                                                  │
│  HIGH — you built this deliberately, you can whiteboard it cold                  │
│  ┌────────────────────────────────────────────────────────────────────────┐   │
│  │ NDJSON streaming trace        useInvestigation StrictMode fix            │   │
│  │ (events.ts, reader loop)      (started-guard + no-cancel-on-cleanup)     │   │
│  │ coverage gate (categories.ts) shared runAgentLoop (base.ts)             │   │
│  │ demo-vs-live split            coverage_item per-tile reveal (briefing)   │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  MEDIUM — you chose it on purpose but the tuning is approximate                  │
│  ┌────────────────────────────────────────────────────────────────────────┐   │
│  │ ~1.1s inter-call spacing      retry/backoff math (client.ts L121-132)    │   │
│  │ 60s cache TTL                 the agent prompts / synthesis instruction  │   │
│  │ maxToolCalls budget = pick    the AES cookie store I wrote around auth   │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  LOW — I use it correctly but I do not know it at the byte level                 │
│  ┌────────────────────────────────────────────────────────────────────────┐   │
│  │ MCP wire protocol internals   OAuth PKCE + DCR mechanics (SDK provider)  │   │
│  │ distributed scale / multi-region / hot-path queues / load balancing      │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  RULE: answer from HIGH. Reach into MEDIUM with "I picked the simple option."    │
│        At the LOW boundary, stop and say so — that's the recovery box.           │
└──────────────────────────────────────────────────────────────────────────────┘
```

Everything in this chapter lives somewhere on that map. The bug stories come from HIGH, the proudest-part comes from HIGH, and the "least confident" answer is you walking yourself, on purpose, down to the LOW band and planting a flag there.

---

## Prompt 1 — "What was the hardest bug you hit?"

┌──────────────────────────────────────────────────────────────────────────┐
│ Surface: tell me about a hard bug.                                          │
│ Probe:   can you debug something you can't see, and isolate cause from      │
│          symptom — or do you just thrash until it works?                    │
└──────────────────────────────────────────────────────────────────────────┘

The strong answer has a shape: symptom, why it was confusing, the insight, the fix, and what made it hard. The hardest bug I hit was a React StrictMode double-fetch in `lib/hooks/useInvestigation.ts`, and it has all five.

Here is how I'd walk it:

The symptom was empty logs. I'd open an investigation page in development, the reasoning trace would render its frame, and then nothing would stream into it. No error in the console. The network tab showed a request that started and got cancelled. In production it was fine. That "dev-only" detail is the whole key, and it's the first thing I'd say out loud, because it tells the interviewer I noticed the discriminating fact instead of just staring at the failure.

The reason dev-only matters: `reactStrictMode` is on, which is the Next.js default, and StrictMode in development mounts a component, immediately runs its effect cleanup, then re-mounts. Two things in my hook were fighting each other inside that mount-cleanup-remount cycle. First, I had a started-guard — a `useRef` so the fetch runs once per mount and I don't fire two streams. Second, I was cancelling the in-flight fetch on effect cleanup, which is the textbook "clean up your effects" move. Apart, both are correct. Together they killed the stream: the first mount started the fetch, the cleanup cancelled it, and then on the re-mount the started-guard said "already started" and blocked the re-fetch. So I cancelled the only request and then refused to make another one. Empty logs.

```
StrictMode dev lifecycle, with the BUG in place:

  mount #1 ──► effect runs ──► startedRef = true ──► fetch() begins streaming
     │
     ▼
  cleanup  ──► abort the fetch         ◄── "good hygiene" cancel
     │            (stream killed)
     ▼
  mount #2 ──► effect runs ──► startedRef already true ──► RETURN, no fetch
     │
     ▼
  result: zero events ever reach the trace → empty logs
```

The insight was that the guard and the cancel were solving for different lifetimes. The guard protects against a *double* fetch; the cancel protects against a *leaked* fetch after unmount. But under StrictMode the cleanup doesn't mean "the user navigated away" — it means "I'm about to remount you." So cancelling on cleanup was treating a fake unmount as a real one.

The fix is two lines of intent. I keep the started-guard so I never fire two streams, and I deliberately do *not* cancel the fetch on cleanup. The in-flight run simply finishes; if the component really did unmount, the `setState` calls are no-ops, which is safe. That tradeoff is written into the file as a comment so the next person doesn't "fix" it back. It's the `NOTE` block at the top of `useInvestigation.ts`: started-guard at line 47, and the deliberate no-cancel decision is the whole reason there's no `AbortController` in that effect.

What made it hard wasn't the fix — it was that it only reproduced under StrictMode, so the failing condition was a dev-only lifecycle quirk, and the symptom ("empty logs") pointed at the stream, the server, or the parser before it pointed at the hook. I had to rule out the server first, which I did by confirming production streamed fine.

┃ "The guard protects against a double fetch; the cancel protects against a leaked one. Under StrictMode they were solving for different lifetimes, and together they cancelled the only request I had."

If they want a second bug — and the strong move is to offer one — I have a cleaner isolation story.

### The second bug, if they push for "anything trickier in production?"

┌──────────────────────────────────────────────────────────────────────────┐
│ Surface: anything that only showed up in prod?                              │
│ Probe:   can you isolate an environment-specific failure methodically?      │
└──────────────────────────────────────────────────────────────────────────┘

The briefing endpoint returned a bare 500 in production while demo mode returned 200. That contrast was the entire diagnosis. Demo mode never touches credentials — it replays a committed JSON snapshot — so demo=200 told me the route, the stream, and the parser were all fine. Live=500 told me the failure was in the credentialed setup path that demo skips. That narrowed it to one thing: the production cookie encryption.

`aesKey()` in `lib/mcp/auth.ts` throws if `AUTH_SECRET` is unset, and it only runs in production because the dev/test backends use a file or an in-memory map. The throw happened during pre-stream setup, before I'd committed to the `ReadableStream`, and it was unguarded, so it surfaced as a bare 500 with no message. The fix was to wrap `getOrCreateSessionId` and `connectMcp` in a try/catch and return the *real* error string — you can see it now at `app/api/briefing/route.ts` lines 161-171. After the fix, the same missing-secret condition returns a 500 that actually says `AUTH_SECRET is required in production…`, and a missing/expired token returns a 401 the feed redirects on, not a 500.

```
ISOLATION BY CONTRAST:

  demo  = 200  ──┐
                 ├──► the route/stream/parser are FINE
  live  = 500  ──┘     (demo exercises all of them, creds-free)
       │
       ▼
  what does LIVE do that DEMO skips?  ──► credentialed setup
       │
       ▼
  what in setup can throw before the stream?  ──► aesKey() on unset AUTH_SECRET
       │
       ▼
  fix: guard the setup, return the real message → 200/401/500 are now honest
```

The teaching point I'd land: I didn't add logging and guess. I used the two environments as a differential — the thing that worked and the thing that didn't differed in exactly one dimension, and that dimension was the answer.

┌─ STRONG vs WEAK — telling a bug story ─────────────┬───────────────────────────────┐
│ WEAK                                                │ STRONG                         │
├─────────────────────────────────────────────────────┼───────────────────────────────┤
│ "There was a race condition with React and the      │ "Empty logs, dev-only. That    │
│  fetch, it was really tricky, I tried a bunch of     │  'dev-only' was the key —      │
│  things and eventually adding a ref fixed it."       │  StrictMode remounts. My guard │
│                                                      │  and my cleanup-cancel were    │
│                                                      │  fighting: I cancelled the     │
│                                                      │  only fetch, then the guard    │
│                                                      │  blocked the remount."         │
├─────────────────────────────────────────────────────┼───────────────────────────────┤
│ Why it's weak: "tried a bunch of things" is         │ Why it works: symptom → the    │
│ thrashing. "Race condition" is a label, not a       │ discriminating fact → the      │
│ mechanism. No discriminating fact, no causal chain. │ mechanism → the fix, and names │
│ I can't tell if you understood it or got lucky.     │ the tradeoff you kept on        │
│                                                      │ purpose. That's diagnosis.     │
└─────────────────────────────────────────────────────┴───────────────────────────────┘

### Follow-up decision tree — where this one usually goes

```
"What was the hardest bug?"  → (the StrictMode double-fetch)
   │
   ├─ "Why not just turn off StrictMode?"
   │     └─► "It's the Next default and it surfaced a real lifecycle bug —
   │          the same remount happens with fast-refresh and remounts in prod
   │          navigation. Disabling it hides the bug, doesn't fix the hook.
   │          I'd rather the hook be correct under remounts."
   │
   ├─ "Don't you leak the request if the user really navigates away?"
   │     └─► "The fetch completes and its setState calls become no-ops after
   │          unmount — that's a wasted response, not a leak or a crash. For a
   │          short investigation stream I traded a rare wasted fetch for a
   │          stream that never aborts mid-flight. If these were expensive or
   │          long-lived I'd add an AbortController gated on a *real* unmount,
   │          not on the first StrictMode cleanup."
   │
   └─ "How did you know it was the hook and not the server?"
         └─► "Production streamed fine and demo mode streamed fine — both hit
              the same server route and the same parser. Only the dev client
              path failed. That pointed at the hook, not the stream."
```

---

## Prompt 2 — "What part are you proudest of?"

┌──────────────────────────────────────────────────────────────────────────┐
│ Surface: what are you proudest of building?                                 │
│ Probe:   do you have taste? what do you think "good" looks like, and did    │
│          you actually build the thing you're claiming?                      │
└──────────────────────────────────────────────────────────────────────────┘

The answer I lead with is the streamed reasoning trace as a first-class surface — the product idea that an analyst should *show its work*, not just hand you a verdict. Most "AI analyst" demos give you a spinner and then a paragraph. Mine streams the agent's actual reasoning steps and tool calls to the UI as they happen, on every page: the feed shows the monitoring scan narrating into a `StatusLog`, and each investigation page renders a `ReasoningTrace` that fills in step-by-step. Those components are real — `components/shared/StatusLog.tsx` and `components/investigation/ReasoningTrace.tsx` — and they're fed by the NDJSON `AgentEvent` contract in `lib/mcp/events.ts`, read off a `ReadableStream` in `useInvestigation.ts` with a plain reader loop, not `EventSource`.

Why I'm proud of it: it's the difference between a tool that asks you to trust it and a tool that earns the trust. When the trace shows the exact EQL query the agent ran and the result it got back, a human analyst can audit the conclusion. That's a product stance, and I built the whole pipe for it — the event types, the server emitting them, the client reading them line by line.

The thing I'd mention second, because it's the same instinct pointed at honesty rather than transparency, is the coverage gate in `lib/agents/categories.ts`. The system runs a fixed 10-category anomaly checklist, but a workspace can only support a category if it emits the events that category needs — `conversion_drop` needs `view_item`, `checkout`, and `purchase`. Before spending any LLM or EQL budget, `coverageReport()` gates the checklist against the live schema and `runnableCategories()` filters to only what the data supports. The categories the workspace can't support render as ghost tiles in `CoverageGrid.tsx` (the `unavailable` branch) instead of being faked. The system tells you "I can't check fraud here because there's no `payment_failure` event" rather than quietly producing a confident, empty answer.

┃ "An analyst that shows its work. The trace isn't a loading animation — it's the audit trail, streamed."

▸ The coverage gate is the same value as the trace, aimed inward: don't fake a category the data can't support; show a ghost tile and say why.

┌─ STRONG vs WEAK — "proudest part" ─────────────────┬───────────────────────────────┐
│ WEAK                                                │ STRONG                         │
├─────────────────────────────────────────────────────┼───────────────────────────────┤
│ "I'm proud of the whole thing, it's a polished      │ "The streamed reasoning trace. │
│  multi-agent AI analyst with a really clean UI."     │  An analyst should show its    │
│                                                      │  work — so I stream the agent's│
│                                                      │  steps and exact EQL to the UI │
│                                                      │  as they happen. It's the      │
│                                                      │  audit trail, not a spinner."  │
├─────────────────────────────────────────────────────┼───────────────────────────────┤
│ Why it's weak: "the whole thing" has no taste in    │ Why it works: one thing, a     │
│ it. "Polished" and "clean" are adjectives, not       │ reason it matters, and it maps │
│ decisions. Nothing here is yours specifically.       │ to files you can open. It's a  │
│                                                      │ point of view, defensible.     │
└─────────────────────────────────────────────────────┴───────────────────────────────┘

### Follow-up decision tree

```
"What are you proudest of?"  → (the streamed reasoning trace)
   │
   ├─ "Why NDJSON over a ReadableStream, not Server-Sent Events?"
   │     └─► "SSE is a heavier contract — event framing, auto-reconnect I
   │          don't want mid-investigation, and it's GET-only. I'm already
   │          doing a fetch; reading newline-delimited JSON off the body
   │          reader is the whole client. One JSON.parse per line."
   │
   ├─ "Isn't showing the reasoning just exposing the model's chain-of-thought?"
   │     └─► "It's the tool calls and their real results, not raw token-level
   │          thinking. The value is auditability — you can see the exact EQL
   │          query and the numbers it came back with, and check the verdict
   │          against them."
   │
   └─ "What if the agent's reasoning is wrong but looks convincing?"
         └─► "That's exactly why I show the EQL and the result, not just the
              prose. A wrong conclusion with the query visible is falsifiable;
              a wrong conclusion behind a spinner isn't."
```

---

## Prompt 3 — "What part are you least confident defending?"

┌──────────────────────────────────────────────────────────────────────────┐
│ Surface: where are you weakest on this project?                             │
│ Probe:   do you know your own boundaries — or will you bluff and get caught?│
└──────────────────────────────────────────────────────────────────────────┘

This is the one to get exactly right, because the wrong instinct is to deflect to something safe ("uh, maybe the CSS could be cleaner"). That fails the probe — it tells the interviewer you either don't know where your real edge is or you won't admit it. The strong move is to walk yourself straight to the LOW band of the confidence map and plant the flag there, on purpose.

My honest answer: the part I'm least confident defending at depth is the MCP wire protocol internals and the OAuth PKCE + DCR mechanics. I use the SDK's `OAuthClientProvider` — that's a *defaulted-to* decision, in the honest sense: I took the SDK's provider shape rather than implementing the flow myself, and I didn't deeply evaluate alternatives because there wasn't a real one worth the time for an alpha integration. What I *do* understand is the shape: PKCE means I send a code challenge and later prove I hold the verifier; DCR means the client registers itself dynamically instead of pre-provisioned credentials; tokens refresh. And I understand — and built — the production store I wrapped around it: my `BloomreachAuthProvider` keys persistence by app session id, and in production I back it with an AES-256-GCM encrypted `bi_auth` cookie, seeded once per request through `AsyncLocalStorage` so the SDK's many synchronous read/write calls don't trip Next's read-after-set cookie split. That wrapper is mine and I can defend every line. What I can't do is recite the byte-level token exchange or the exact PKCE challenge derivation from memory.

That distinction — *defaulted-to the SDK for the protocol, deliberate for the wrapper* — is the senior move. I'm not claiming to have implemented OAuth; I'm claiming to know precisely where the SDK's responsibility ends and mine begins.

There's a second answer here that's actually sharper, and I'd offer it second if they let me, because it's the answer a staff interviewer would respect most: **the part I'm least confident defending isn't a protocol — it's the eval gap.** There is no `evals/` directory in this repo. No goldset, no judge, no agreement rate. Every prompt edit and every model swap ships with zero quality measurement, and the 169 tests prove plumbing, not output quality. The infrastructure to do evals well is actually built — the NDJSON trace is a span sequence, `lib/state/investigations.ts` replays it deterministically, `parseAgentJson` gives me typed agent outputs to score, the scripted-Anthropic harness proves the seam works against a fake — five seams, all cut. The keystone module is the only one missing. So if an L4 interviewer asks "how do you know any of the agent outputs are good," the honest answer today is "I don't, beyond eyeballing the trace" — and the move I'd respect from a candidate is to say that flatly and then describe the harness I'd build, not to dodge into the test count. I have the recipe written down (`.aipe/drills/evals-observability-induce-eval-gap-build-min-eval-harness.md` — 10-case goldset, LLM-as-judge, measured agreement rate, ~5 hours). Owning the gap with a concrete recipe is the L5 move; pretending the unit tests cover it is the L1 collapse.

One more honest gap, while we're here: a11y on the streaming surfaces. The reasoning trace, the coverage grid resolving live, the insight cards dropping in — none of those streamed regions is wrapped in `aria-live`, `role="status"`, or `role="log"`. A screen-reader user gets silence while a sighted user watches the agent think. That's not a regret; it's a discipline I didn't build into the project, and the fix is small (the regions exist; they just need the right ARIA roles). If they push, I'd own it the same way as the eval gap — name what's there, name what isn't, and name the cheap concrete fix.

╔══════════════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY BOX — pushed on OAuth/MCP protocol internals           ║
║                                                                                ║
║ The pushback: "Walk me through the PKCE handshake byte by byte." or            ║
║               "How does the MCP transport frame a tool call on the wire?"      ║
║                                                                                ║
║ Say: "I'm going to be honest about my boundary here. I use the MCP SDK's       ║
║      OAuthClientProvider — that's a defaulted-to decision, I took the SDK's    ║
║      flow rather than implementing it. I know the shape: PKCE proves I hold    ║
║      the verifier, DCR registers the client dynamically, tokens refresh. What  ║
║      I built and can defend in full is the persistence around it — the         ║
║      session-keyed provider and the AES-256-GCM cookie store with the          ║
║      AsyncLocalStorage seeding. I can't recite the byte-level exchange."       ║
║                                                                                ║
║ What this signals: you know the boundary between SDK and your code, you can    ║
║      name your decision mode honestly, and you don't bluff protocol internals  ║
║      you didn't implement. That reads as senior, not junior.                   ║
║                                                                                ║
║ Do NOT say: "Yeah, so PKCE generates a random verifier and then…" and          ║
║      improvise. If you get a detail wrong the whole answer collapses, and a    ║
║      bluff caught here poisons everything else you've said.                    ║
╚══════════════════════════════════════════════════════════════════════════════╝

┃ "I defaulted to the SDK for the protocol and built the cookie store around it deliberately. I can defend the wrapper to the line; I won't bluff the byte-level handshake."

The same boundary discipline applies if they pivot to distributed scale — multi-region, hot-path queues, load balancing. That's also LOW band for me, and I say so the same way: "I haven't run this at horizontal scale; my state is in-memory per Vercel instance on purpose for a single-upstream demo. I can reason about what I'd add — a shared store, a persistent investigation store — but I'd be theorizing past where I've shipped." Chapter 4 has the scale reasoning; here the move is just to mark the edge cleanly.

### Follow-up decision tree

```
"What are you least confident defending?"  → (MCP/OAuth protocol internals)
   │
   ├─ "So you don't really understand OAuth?"
   │     └─► "I understand the flow shape and the security properties — PKCE
   │          stops an intercepted code from being redeemed without the
   │          verifier. What I delegated is the wire-level implementation, to
   │          the SDK. I drew the line where the SDK draws it."
   │
   ├─ "What would you have to learn to own the whole flow?"
   │     └─► "The exact authorization-code grant exchange, the PKCE challenge
   │          derivation (S256 hash of the verifier), and the DCR registration
   │          request shape. I know what they do; I'd need to learn the exact
   │          byte formats to implement them without the SDK."
   │
   └─ "Why did you build your own cookie store instead of using the SDK's?"
         └─► "The SDK's default persistence assumes one process. On Vercel the
              connect and callback requests land on different ephemeral
              instances, so I needed a store both can read — the encrypted
              cookie — and the AsyncLocalStorage seeding to dodge Next's
              read-after-set split. That part was a real, deliberate problem."
```

---

## Prompt 4 — "Tell me about a time you debugged something subtle." (the coverage-reveal story)

┌──────────────────────────────────────────────────────────────────────────┐
│ Surface: tell me about a subtle bug, or how you debug in general.           │
│ Probe:   can you measure instead of guess, and prove where a problem is     │
│          before you fix it?                                                 │
└──────────────────────────────────────────────────────────────────────────┘

This is the story I reach for when the question is really "how do you debug?" rather than "what's the worst bug?" — because it's all measurement and no luck.

The symptom: the anomaly-coverage grid "loaded all at once." The per-category checklist *logs* streamed into the status panel fine, one line at a time, but the grid tiles all resolved in a single pop at the end. That mismatch — logs incremental, grid not — was the clue. The naive read is "the server isn't streaming the grid data." So I measured: I checked when each line actually arrived off the stream. The server *was* streaming fine, line by line. The grid was the problem: it resolved from a single bulk `coverage` event emitted *after* the whole checklist, so no matter how the lines arrived, the tiles had nothing to render against until that one event landed.

The fix was to emit coverage *per category* — a `coverage_item` event per tile — so each tile resolves in step with its own log line, and the grid renders pending "checking…" skeleton tiles for categories it hasn't heard about yet. You can see both in the code: the briefing route loops and emits a log line then its `coverage_item` together (`app/api/briefing/route.ts` around lines 113-118 in the demo replay, and 209-212 in the live path), and `CoverageGrid.tsx` renders the pending "checking…" tile when a category hasn't reported yet (the `loading` branch, around line 145).

Now here's the honest nuance, and saying it unprompted is the senior signal in this whole story: the tile-by-tile reveal is genuinely incremental in the *demo* replay, because the replay paces events at `REPLAY_DELAY_MS = 140`. On a *live* run, the coverage gate is a pure synchronous function over the schema — it's instant — so the tiles still effectively resolve at once, and the genuinely incremental live work is the EQL trace that comes after, not the gate. I'm not going to claim the gate streams meaningfully in production when it doesn't. The `coverage_item` change made the *presentation* honest and the demo paced; it didn't make an instant computation slow.

```
WHAT I MEASURED → WHAT I CONCLUDED:

  observation: log lines arrive one-by-one  ┐
               grid tiles arrive all-at-once ┘ ── a MISMATCH, so where's the seam?
       │
       ▼
  measure per-line arrival off the stream ──► server streams each line fine
       │
       ▼
  so the seam is downstream of the server ──► the grid waited on ONE bulk
       │                                       `coverage` event after the checklist
       ▼
  fix: emit `coverage_item` per category ──► tile resolves with its own line;
       │                                     unreported tiles show "checking…"
       ▼
  honest nuance: incremental for real only in the DEMO (paced 140ms);
                 live gate is instant — the live incremental work is the EQL trace
```

┃ "I didn't guess where the stall was — I measured per-line arrival and proved the server streamed fine, so the grid was the issue."

▸ The senior tell: I volunteered that the tile reveal is only truly paced in the demo. Owning the nuance beats overselling the fix.

╔══════════════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY BOX — "so it doesn't really stream live?"              ║
║                                                                                ║
║ The pushback: "You just said the gate is instant live — so the streaming      ║
║               grid is basically a demo effect?"                                ║
║                                                                                ║
║ Say: "For the gate, yes — it's a synchronous schema check, so live it          ║
║      resolves at once and I'm not going to pretend otherwise. The streaming    ║
║      that matters live is the EQL trace, where each query genuinely takes      ║
║      time. The `coverage_item` change made the presentation honest — a tile    ║
║      maps to its own log line — and made the demo paced. I separated those     ║
║      two claims on purpose."                                                   ║
║                                                                                ║
║ What this signals: you distinguish real behavior from presentation, and you    ║
║      don't let a clean demo tempt you into overstating what the system does.   ║
║                                                                                ║
║ Do NOT say: "No no, it fully streams live too" — it doesn't, and the gate is   ║
║      a pure function they can read in categories.ts. Getting caught            ║
║      overstating here costs you the whole "shows its work" credibility.        ║
╚══════════════════════════════════════════════════════════════════════════════╝

---

## What you'd change

If I redid the hardest-bug work, the change isn't to the fix — the started-guard plus no-cancel-on-cleanup is correct and I'd keep it. It's that I'd reach for the differential sooner. With the StrictMode bug I spent time suspecting the server and the parser before the "dev-only, prod-fine" fact made me look at the hook; with the bare-500 I got to the demo-vs-live contrast fast and it paid off immediately. The lesson I carry forward is to start every "works here, fails there" bug by writing down the one dimension the two environments differ in, before touching code. On the coverage-reveal story I'd change less — measuring before fixing is exactly what I'd do again — but I'd add a small note in the code that the live gate is instant so a future reader doesn't try to "fix" the grid into streaming a synchronous computation.

---

## One-page summary — Chapter 6

**Core claim:** I can walk a real bug from symptom to insight to fix, name what I'm proudest of with a point of view behind it, and mark my own weakest spot cleanly — the LOW band of the confidence map — without bluffing.

| Prompt | One-line answer |
|---|---|
| Hardest bug? | StrictMode double-fetch in `useInvestigation.ts`: my started-guard and cleanup-cancel fought — cancelled the only fetch, then blocked the remount. Fix: guard + no-cancel-on-cleanup. |
| Trickier in prod? | Briefing bare-500: demo=200 vs live=500 isolated it to the credentialed setup; `aesKey()` threw on unset `AUTH_SECRET`, unguarded. Wrapped setup, returned the real message. |
| Proudest part? | The streamed reasoning trace — an analyst that shows its work — backed by the coverage gate that ghosts categories the data can't support instead of faking them. |
| Least confident? | Two honest answers: (1) **the eval gap** — no `evals/`, no goldset, no agreement rate; 169 tests prove plumbing, not output quality; I have the harness recipe written down and would build it next. (2) MCP/OAuth protocol internals — defaulted-to the SDK's provider; I defend the wrapper, not the byte-level handshake. Streaming a11y is the same shape of admission: no `aria-live` on the trace, fix is small. |
| Subtle debug? | Coverage "loaded all at once": measured per-line arrival, proved the server streamed fine, the grid waited on one bulk event. Fix: `coverage_item` per tile — honestly only paced in the demo. |

**Pull quotes:**
- "The guard protects against a double fetch; the cancel protects against a leaked one — they were solving for different lifetimes."
- "An analyst that shows its work. The trace isn't a loading animation — it's the audit trail, streamed."
- "I defaulted to the SDK for the protocol and built the cookie store around it deliberately. I won't bluff the byte-level handshake."
- "I didn't guess where the stall was — I measured per-line arrival and proved the server streamed fine."

**The "what you'd change" sentence:** I'd write down the single dimension two environments differ in before touching code, and leave a note that the live coverage gate is instant so nobody tries to make a synchronous computation stream.

---
Updated: 2026-05-29 — created
Updated: 2026-06-03 — Prompt 3 ("least confident defending") absorbed two new honest gaps from the recon + a11y audits: (1) the eval gap as the sharper L4-grade answer (five substrate seams cut, the harness keystone missing — recipe written in `.aipe/drills/evals-observability-*.md`); (2) streaming-surface a11y (no `aria-live` on the trace/coverage/insights) as a clean "what I'd add" admission. One-page summary updated to match.
