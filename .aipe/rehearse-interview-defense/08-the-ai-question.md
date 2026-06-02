# Chapter 8 — The AI question

In 2026 every senior interviewer assumes you built this with heavy AI assistance, because everyone does. So "did you use AI to build this?" is not a trap and it is not asking for a confession. It's asking one thing: *do you understand what you shipped well enough to own it?* The candidates who fail this question fail by getting defensive or evasive — as if using AI were cheating. The candidates who pass are matter-of-fact about the tool, matter-of-fact about their own role, and specific about the line between the two.

This chapter is about answering that cleanly, and about the follow-ups that do the real probing: "explain this section line by line," "what did the AI get wrong?" You built an AI product *with* AI — that's not awkward, it's the most natural thing in the room, as long as you can show where your judgment lived.

## What AI did, what you did

The honest answer isn't "I did it" or "AI did it" — it's a split, and this is the picture of where the line falls.

```
  WHAT AI DID                          WHAT YOU DID
  ═══════════════════════════════      ═══════════════════════════════════

  drafted boilerplate                  decided the PRODUCT — "an analyst
  (route scaffolding, types,           that shows its work"; the three-
  component shells)                    stage loop; reasoning as a
        │                              first-class streamed surface
        │                                    │
  suggested library APIs               designed the CONTROL — maxToolCalls
  (SDK call shapes, the                budget + forced synthesis; ~1.1s
  tool-use loop skeleton)              spacing; no-cache-on-error
        │                                    │
  filled in the OAuth                  built the SCHEMA GATE — categories
  PKCE+DCR flow from the               classified against the live schema
  SDK defaults                         before spending budget
        │                                    │
        ▼                                    ▼
  ┌──────────────────────┐            ┌──────────────────────────────────┐
  │ DEFAULTED-TO          │            │ DELIBERATE + EVALUATED-AND-       │
  │ accepted without      │            │ ACCEPTED                          │
  │ deep evaluation       │            │ your judgment, named criteria     │
  │ → own it AS a default │            │ → defend in depth                 │
  └──────────────────────┘            └──────────────────────────────────┘

  the debugging was YOURS either way:
  the StrictMode double-fetch, the prod 500, the "all at once" coverage
  reveal — AI wrote code that looked right; you found why it wasn't.
```

The line isn't "AI did the easy parts, I did the hard parts." It's "AI accelerated the typing; the decisions and the debugging were mine." Make that the shape of every answer in this chapter.

---

## "Did you use AI to build this?"

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "Did you use AI to build this?"                             │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   Not whether you used it — they assume you did. Whether you  │
> │   can talk about it without defensiveness, and whether you    │
> │   can locate the boundary between what you delegated and what │
> │   you decided.                                                │
> └─────────────────────────────────────────────────────────────┘

In your voice, flat and unbothered:

"Yes, heavily — it's how I work, and building an AI product with AI tools felt like the right way to learn the domain. The useful way to answer is to split it. The decisions were mine: the product concept, the three-stage loop, making the reasoning a streamed first-class surface, the `maxToolCalls` budget that keeps an agent from wandering against a rate-limited server. Some choices I evaluated and accepted — the two-model split, NDJSON over SSE. And some I defaulted to the tool's suggestion without deeply evaluating — the OAuth PKCE flow is the SDK's, and I accepted it. I can tell you which bucket any part of this falls into, and I think that's the real question."

That last line is the move. You're telling the interviewer you've already done the categorization they're about to probe for.

```
┃ The decisions were mine; AI accelerated the typing. I can
┃ tell you which bucket any part of this falls into.
```

```
┌──────────────────────────────────┬──────────────────────────────────┐
│ WEAK ANSWER                       │ STRONG ANSWER                     │
├──────────────────────────────────┼──────────────────────────────────┤
│ "I mean, I used it for some       │ "Yes, heavily. The decisions were │
│  boilerplate, but I wrote the     │  mine, AI accelerated the typing, │
│  important parts myself and I     │  and I can tell you for any part  │
│  understand all of it."           │  whether I decided it, evaluated  │
│                                   │  and accepted it, or defaulted to │
│                                   │  the tool. Pick a section."       │
├──────────────────────────────────┼──────────────────────────────────┤
│ Why it's weak:                    │ Why it works:                     │
│ defensive ("but I wrote the       │ no defensiveness, an explicit     │
│ important parts") and             │ framework for the boundary, and   │
│ over-claims ("understand ALL of   │ an invitation to be tested. It    │
│ it"). The next question — "okay,  │ signals you've already thought    │
│ explain this part" — will catch   │ about exactly what the interviewer│
│ the over-claim. You set your own  │ is probing for, so the follow-up  │
│ trap.                             │ has nowhere surprising to go.     │
└──────────────────────────────────┴──────────────────────────────────┘
```

---

## "Can you explain this section line by line?"

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "Pick a file — can you explain it line by line?"            │
> │   (or they pick the file)                                     │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   The over-claim detector. If you said "I understand all of   │
> │   it," this is where it breaks. They want to see whether your │
> │   understanding is real or borrowed.                          │
> └─────────────────────────────────────────────────────────────┘

If you get to pick, pick something you own deliberately. In your voice:

"Let me walk `runAgentLoop` — it's the core. It takes the Anthropic client and the MCP client as injected dependencies, which is what makes it testable with fakes. It calls the model with the agent's tool schema, runs whatever tool calls the model asks for through the MCP client, feeds the results back as tool-result messages, and repeats. The termination is the part I care about: there's a `maxToolCalls` budget, and once it's spent I stop passing tools on the next turn, which forces the model to synthesize a final answer instead of calling more tools. That's how I bound an agent against a server I can only hit about once a second."

If *they* pick a file and it's one you defaulted to, do not bluff — pivot honestly. That's the recovery box below. The skill being tested is whether you can tell your deep regions from your shallow ones in real time.

```
"Did you use AI?" → "Yes."
        │
        ▼
  ├─► IF THEY SAY "explain a section line by line"
  │     → offer one you own: runAgentLoop, the coverage gate
  │       (schemaCapabilities → coverageReport), or the NDJSON
  │       reader's line-buffer. Walk it with the mechanism, not
  │       a paraphrase.
  │
  ├─► IF THEY SAY "what did the AI get wrong?"
  │     → you have THREE real bugs ready (below). This is a gift
  │       question — it's where you look most senior.
  │
  └─► IF THEY SAY "how much of this could you have written
        without AI?"
        → "All of it, slower. The loop, the streaming, the gate
           are concepts I understand. AI saved me typing and
           lookup time, not understanding. The OAuth flow is the
           one part I'd have had to actually learn to write."
```

---

## "What did the AI get wrong?"

This is the question that makes you look most senior, because the answer is a debugging story where *you* are the one who caught the machine. You have three real ones.

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "What did the AI get wrong, or where did you have to        │
> │    correct it?"                                               │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   Whether you were driving or being driven. A candidate who   │
> │   can't name a single thing AI got wrong was never really in  │
> │   control — they accepted output they couldn't evaluate.      │
> └─────────────────────────────────────────────────────────────┘

In your voice — pick one, have all three ready:

"Three come to mind. First, a React StrictMode bug: the investigation hook cancelled its in-flight fetch on effect cleanup, which combined with a run-once guard to abort the stream on the dev double-mount — the logs came up empty. The fix was to keep the run-once guard but stop cancelling on cleanup, since a `setState` after unmount is a safe no-op. AI-generated code that looked correct in isolation broke under StrictMode's intentional double-invoke.

Second, a production-only 500: the briefing endpoint threw a bare 500 in prod but worked in demo. The cause was the auth cookie's encryption key throwing when an environment secret was unset, during the pre-stream setup, unguarded. I isolated it by noticing demo returned 200 and live returned 500 — so it was the auth path, before the stream. The fix wrapped setup so it returns the real error.

Third, the coverage grid 'loaded all at once.' The per-category logs streamed fine, but the grid resolved from a single bulk event. I proved the server was streaming correctly by measuring per-line arrival timing, which told me the grid was the issue, not the stream — and switched to emitting coverage one category at a time."

```
        ▸ "What did the AI get wrong?" is a gift. It's the one
          question where the honest answer is a story of you
          catching the machine.
```

Notice the honest nuance you can add to the third one: the tile-by-tile reveal you built is real in the *demo replay*, which is paced — on a live run the gate is instant, so the grid resolves at once and the genuinely incremental work is the EQL trace. Volunteering that distinction, unprompted, is a strong senior signal: you know the difference between a real-time effect and a replayed one in your own product.

There's a fourth one you can volunteer if it lands — a correctness bug AI suggested *and* I accepted, which I caught later, not at write-time: `lib/state/insights.ts` line 4 holds the insights `Map` as a module-level global, and `putInsights` line 36 calls `insights.clear()` at the top of every briefing write. For one user that's correct; for two concurrent users on one warm Vercel instance, user A's briefing wipes user B's mid-session. The pattern is what AI assistance is *worst* at: it produces locally-correct code that breaks under a concurrency assumption never written down. The fix is ~30 LOC — session-key the Map — and the lesson is that an AI-suggested in-memory store needs a written concurrency model before it gets accepted, not after. Saying this out loud — "AI wrote this, I accepted it, I later read it as a real bug and here's the fix" — is the strongest possible version of owning a defaulted-to decision.

---

╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                           ║
║                                                               ║
║   They pick the file you defaulted to: "Walk me through the   ║
║   OAuth provider — line by line, what's happening in the      ║
║   PKCE exchange?"                                             ║
║                                                               ║
║   Say:                                                        ║
║   "This is the part I defaulted to. The PKCE and Dynamic      ║
║    Client Registration flow is the MCP SDK's OAuth provider;  ║
║    I implemented the SDK's provider interface and accepted    ║
║    its flow rather than writing the exchange myself. I know   ║
║    the shape — code verifier and challenge, the redirect, the ║
║    token exchange — but I can't walk you line by line through ║
║    the SDK's exchange because I didn't write it. What I DID   ║
║    write and can walk line by line is the token store around  ║
║    it: the AES-256-GCM encrypted cookie in prod, the file     ║
║    store in dev, and the AsyncLocalStorage seam that flushes  ║
║    it per request. Want that?"                                ║
║                                                               ║
║   What this signals: you can locate a defaulted-to region     ║
║   precisely, you're honest that you didn't write it, and you  ║
║   immediately redirect to adjacent code you genuinely own.    ║
║   That's the senior way to own a default.                     ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "Sure — so it generates a code verifier, hashes it for the  ║
║    challenge, and then... um... sends that to the authorize   ║
║    endpoint, and..." — narrating a flow you didn't write,     ║
║    from memory of its shape, collapses on the first "and      ║
║    then what does the server return?"                         ║
╚═══════════════════════════════════════════════════════════════╝

---

## What you'd change

About how you *used* AI, not about the code: you'd keep a tighter log of the defaulted-to decisions as you made them. The OAuth flow, the encryption parameters, the backoff constants — you can identify them as defaults now, in hindsight, but you reconstructed that boundary after the fact. The senior habit is to mark a decision as "accepted the tool's default, didn't evaluate" *at the moment you make it*, so the boundary between your judgment and the tool's is a record, not a reconstruction. Next project, that log is the thing you'd start on day one — it's exactly what makes this interview question easy to answer.

---

## One-page summary (night-before review)

**Core claim:** The question isn't whether you used AI — it's whether you can locate the boundary between what you decided, what you evaluated, and what you defaulted to, and own each honestly.

**The questions covered:**
- *"Did you use AI?"* → "Yes, heavily. The decisions were mine; AI accelerated the typing. I can bucket any part as deliberate, evaluated-and-accepted, or defaulted-to."
- *"Explain a section line by line."* → Offer one you own (`runAgentLoop`, the coverage gate, the NDJSON line-buffer); walk the mechanism, not a paraphrase.
- *"What did the AI get wrong?"* → Four real ones you caught: the StrictMode double-fetch, the prod-only 500, the all-at-once coverage reveal, and the global-`Map` + `putInsights.clear()` concurrent-user wipe in `lib/state/insights.ts` (an AI-default I accepted at write-time and only caught later when reading for concurrency).
- *"How much could you write without AI?"* → "All of it, slower — except the OAuth flow, which I'd have had to actually learn."

**Pull quotes:**
- The decisions were mine; AI accelerated the typing. I can tell you which bucket any part falls into.
- "What did the AI get wrong?" is a gift — the honest answer is a story of you catching the machine.

**What you'd change:** Keep a real-time log of defaulted-to decisions as you make them, so the judgment/default boundary is a record, not a reconstruction.

---
Updated: 2026-05-29 — created
Updated: 2026-06-02 — Added a fourth "what did AI get wrong" candidate: the `lib/state/insights.ts` global-Map + `putInsights.clear()` concurrent-user race — strongest possible version of owning a defaulted-to decision, per study-system-design audit's CRITICAL red-flag finding.
