# Chapter 8 — The AI question

  ## Opening hook

This is the 2026 meta-question. Some version of it shows up in every senior interview now: "did you use AI to build this?" "Can you explain this section line by line?" "What did AI get wrong?" The interviewer already knows the answer to the first one is yes — that's the default in 2026 and nobody on a senior hiring committee thinks otherwise. What separates the strong answer from the weak one is whether you understand what you shipped well enough to own it.

The chapter teaches you a three-mode framework for talking about *how* AI shaped each decision: **deliberate** (you decided, AI executed), **evaluated-and-accepted** (AI suggested, you evaluated and accepted), **defaulted-to** (AI's default, you didn't deeply evaluate). All three are legitimate. The first signals strong engineering judgment. The second signals strong taste. The third is the one with the most risk and the most senior-signal upside when owned well — because every engineer in the room has defaulted-to decisions in their code, and almost nobody owns them honestly.

The picture below is the split diagram: what AI did, what you did, what got blurry between you, and where the blurry parts produced real bugs.

  ## The picture you draw — what AI did, what you did

```
  blooming insights — what AI did, what I did, what's blurry

  ┌─ DELIBERATE (I decided, AI executed) ────────────────────────┐
  │  the agent pipeline shape (3 agents matching user flow)      │
  │  the hand-rolled loop in Phase 1 (maxToolCalls + forced      │
  │     synthesis turn) — the budget concern was MINE             │
  │  the DataSource seam itself                                  │
  │  the "stream reasoning as first-class output" product call   │
  │  the demo-first default                                      │
  └──────────────────────────────────────────────────────────────┘

  ┌─ EVALUATED-AND-ACCEPTED (AI suggested, I evaluated) ─────────┐
  │  ★ the AptKit migration (Phase 4) — primitive boundary        │
  │     evaluated against legacy loop, accepted                   │
  │  the NDJSON-over-fetch shape (vs SSE)                        │
  │  Sonnet 4.6 for agents, Haiku 4.5 for intent classification  │
  │  the session-keyed insights map AFTER the bug surfaced       │
  └──────────────────────────────────────────────────────────────┘

  ┌─ DEFAULTED-TO (AI's default, I didn't deeply evaluate) ──────┐
  │  OAuth PKCE + Dynamic Client Registration mechanics          │
  │     — followed spec, didn't independently verify each step    │
  │  Tailwind v4 token surface (which utilities, defaults)       │
  │  Next 16 App Router conventions (file-naming, route shape)   │
  └──────────────────────────────────────────────────────────────┘

  ┌─ WHAT AI GOT WRONG (the bugs) ───────────────────────────────┐
  │  1. insights.ts concurrent-user wipe — AI suggested global   │
  │     Map<id, Insight>; I accepted at write-time; for two      │
  │     concurrent users on one warm instance, A's write wiped   │
  │     B's mid-session. Fix: session-key the map. SHIPPED.      │
  │  2. StrictMode double-fetch in useInvestigation — pattern    │
  │     was idiomatic individually; broken in interaction.       │
  │  3. The bare 500 from aesKey() — setup throw before stream   │
  │     started; only bit in prod.                               │
  │  4. The "all at once" coverage reveal — server streamed      │
  │     fine; grid resolved from one bulk event. Fix: emit       │
  │     coverage_item per category.                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ WHAT AI HELPED WITH (one specific big lift) ────────────────┐
  │  ★ the AptKit migration itself — AI helped me read the       │
  │    primitive surface and design the adapter classes.         │
  │    Evaluated-and-accepted; I own the boundary.               │
  └──────────────────────────────────────────────────────────────┘
```

Four bands. Each band is honest about its mode. The bugs band is the receipt of failure; the helped-with band is the receipt of leverage. Both stay in the picture.

  ## The body — owning each mode honestly

  ### The opener — "did you use AI to build this?"

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Did you use AI to build this?"                           │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Will you be defensive, evasive, or grounded? The answer   │
  │   they want is grounded. The answer they DON'T want is      │
  │   either denial ("not really") or false humility ("AI did   │
  │   most of it lol").                                         │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "Yes — significant AI assistance, which is table stakes in 2026 and I assume you already knew that's true for every project a candidate brings in. What's more useful is how I think about it.
>
> I split AI's role into three modes. Deliberate — I decided, AI executed. Evaluated-and-accepted — AI suggested, I evaluated against alternatives and accepted. Defaulted-to — AI's default, I didn't deeply evaluate because the default was good enough for the project's stage.
>
> All three are legitimate modes. The risky one is the third, because defaulted-to decisions are the ones that bite when scope changes or scale changes. The senior move is to know which decisions are in which mode. I'll walk you through the picture if you want."

```
  ┃ "Three modes: deliberate, evaluated-and-accepted,
  ┃  defaulted-to. All three are legitimate. The senior
  ┃  move is knowing which decisions are in which mode."
```

```
  ┌─────────────────────────┬─────────────────────────────────┐
  │ WEAK ANSWER             │ STRONG ANSWER                   │
  ├─────────────────────────┼─────────────────────────────────┤
  │ "AI helped, but I       │ "Yes — significant AI           │
  │  understand all the     │  assistance, table stakes in    │
  │  code I shipped."       │  2026. I split AI's role into   │
  │                         │  three modes: deliberate,       │
  │                         │  evaluated-and-accepted,        │
  │                         │  defaulted-to. The senior move  │
  │                         │  is knowing which decisions are │
  │                         │  in which mode."                │
  ├─────────────────────────┼─────────────────────────────────┤
  │ Why it's weak: defensive.│ Why it works: matter-of-fact   │
  │ "But I understand"      │ about AI's role, offers a       │
  │ telegraphs that you     │ framework for evaluating it,    │
  │ think the interviewer   │ confident without being         │
  │ was about to attack.    │ defensive. Treats the question  │
  │                         │ as substantive, not a trap.    │
  └─────────────────────────┴─────────────────────────────────┘
```

  ### The follow-up — "what did AI get wrong?"

This is the question that separates the strong candidate from the average one. The wrong move is to claim AI got nothing wrong (instant fail) or to list trivia ("once it suggested a deprecated import"). The strong move is to walk one or two real bugs where AI's default became a bug *you read as a real bug, fixed, and shipped*.

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "What did AI get wrong?"                                  │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Can you name a real bug where AI's default became your    │
  │   problem? Did you read it as a real bug or did you cargo-  │
  │   cult around it? Did the fix ship?                         │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer (the gold-thread bug):**

> "Four real ones. Let me lead with the cleanest.
>
> `lib/state/insights.ts` originally was a single module-level `Map<id, Insight>` — that's what came out when I asked AI to scaffold session state, and I accepted it at write-time without thinking hard about the warm-instance lifecycle. For a single user it's fine. For two concurrent users on one warm Vercel instance, the next briefing's `putInsights` call ran `clear()` on the global map and wiped user B's feed mid-investigation. The bug only existed under concurrency on a warm instance, which is exactly the production shape but not the local-dev shape, so I shipped the bug.
>
> Once I read it as a real bug, the fix was small. Session-keyed the map: outer `Map<sessionId, SessionFeed>`, three inner maps per session, only the inner maps cleared per briefing run. The fix is at `lib/state/insights.ts` and the comment on `putInsights` explicitly calls out: *Only this session's sub-maps are cleared — never the outer map, never another session's feed.*
>
> The honest framing here is: AI wrote this, I accepted it, I later read it as a real bug, here's the fix and it shipped. That's a defaulted-to decision that bit me. The senior move is owning the whole arc, not just the fix."

```
  ┃ "AI wrote this, I accepted it, I later read it as
  ┃  a real bug, here's the fix and it shipped."
```

**The other three (have them ready as follow-ups):**

> "*StrictMode double-fetch in `useInvestigation`* — the original effect had both a guard and a cleanup-cancel. Idiomatic individually, broken in interaction; the cleanup aborted the only fetch under StrictMode and the guard blocked the second mount from re-firing it. Fix: kept the guard, dropped the cancel.
>
> *The bare 500 from `aesKey()`* — setup throw on missing `AUTH_SECRET` was unguarded, pre-stream. Demo returned 200, live returned 500 — the contrast taught me where the bug was. Fix: wrap setup inside the stream, emit a real error event.
>
> *The 'all at once' coverage reveal* — the server streamed fine but the grid resolved from a single bulk event. Fix: emit a `coverage_item` per category so the grid fills in progressively, matching the rest of the streaming surface."

  ### The deeper probe — "explain this section line by line"

The interviewer points at a specific file and asks you to walk it. They're testing whether you actually understand the code you shipped or whether you'd freeze on a paste-back.

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Open lib/agents/aptkit-adapters.ts. Walk me through it." │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Can you read your own code under pressure? Do you know    │
  │   what each class does and why each one exists? Or did AI   │
  │   write a class you've never opened?                        │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "This is the bridge. Three classes. About two hundred lines total.
>
> `AnthropicModelProviderAdapter` implements AptKit's `ModelProvider` interface. Its job is to take an AptKit `ModelRequest` — system prompt, messages, tools, signal — and turn it into an Anthropic SDK `messages.create` call, then translate the response back into AptKit's `ModelResponse` shape. The translation functions at the bottom — `toAnthropicMessage`, `toAnthropicContentBlock`, `toModelContentBlock` — are pure mapping between the two type surfaces. The `console.log` at line 60 is where I log `res.usage` per turn for token-spend observability.
>
> `BloomingToolRegistryAdapter` implements AptKit's `ToolRegistry`. Its job is to expose the tools my DataSource knows about and to execute calls. The constructor takes the `dataSource` and the list of MCP tool definitions. `listTools` flattens the MCP tool def into AptKit's shape. `callTool` is the load-bearing line — it forwards through the DataSource seam: `dataSource.callTool(name, args, options)`. The `{result, durationMs}` envelope passes straight through.
>
> `BloomingTraceSinkAdapter` implements `CapabilityTraceSink`. Its job is to take AptKit's typed `CapabilityEvent`s and emit them as Blooming's `ToolCall` events through the hooks the route handler set up. The active-tool-calls map at line 101 is the load-bearing part — it pairs `tool_call_start` with `tool_call_end` so the duration and result land on the right call when there are concurrent tools in flight.
>
> That's all three. Library owns the loop and the type primitives; this file is the only place Blooming-specific shapes meet AptKit-specific shapes. The boundary is small on purpose."

  ## When you don't know

The trap on this chapter is being asked to defend the *internals* of a defaulted-to decision — OAuth PKCE + DCR being the canonical example. You implemented the protocol; you don't have a deep grasp of each step's threat model.

```
  ╔═══════════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                           ║
  ║                                                               ║
  ║   They ask: "Walk me through the PKCE flow. Why is the code   ║
  ║   verifier necessary on top of the authorization code? What   ║
  ║   threat does it close?"                                      ║
  ║                                                               ║
  ║   You implemented PKCE via the MCP SDK's OAuthClientProvider. ║
  ║   You followed the spec. You did not independently verify     ║
  ║   each step's threat model.                                   ║
  ║                                                               ║
  ║   Say:                                                        ║
  ║   "PKCE is one of my defaulted-to decisions. I implemented    ║
  ║    it through the MCP SDK's OAuthClientProvider, following    ║
  ║    the spec — code verifier, code challenge, the s256         ║
  ║    transform. I know the rough shape: it binds the token      ║
  ║    exchange to the original initiator, so a stolen            ║
  ║    authorization code can't be redeemed without the verifier. ║
  ║    Beyond that — the specific threat model that drove PKCE,   ║
  ║    why s256 and not plain — I'd be reciting, not              ║
  ║    understanding. If you wanted to probe the threat model,    ║
  ║    can you start me off?"                                     ║
  ║                                                               ║
  ║   What this signals: honest naming of the decision as         ║
  ║   defaulted-to, a real working understanding of the           ║
  ║   mechanism (binding token exchange to initiator), a clean    ║
  ║   handoff on the substrate-level threat-model question.       ║
  ║                                                               ║
  ║   Do NOT say:                                                 ║
  ║   "PKCE is for mobile clients where you can't keep a          ║
  ║    client secret..." — pasting back a single textbook line    ║
  ║   is worse than ceding the gap honestly. Senior interviewers  ║
  ║   probe past the textbook line.                              ║
  ╚═══════════════════════════════════════════════════════════════╝
```

  ## What you'd change about the AI relationship itself

If you were redoing how you *worked with AI* on this project, the change you'd make is **stronger early review of defaulted-to decisions** — specifically, treating the first review of any AI-scaffolded state, lifecycle, or concurrency code as a deliberate code review rather than a "looks reasonable, ship it." Three of the four bugs in this chapter came from AI defaults that I accepted at write-time and only read as bugs much later, in production. Two were in concurrency-adjacent code (the wipe, the StrictMode interaction); one was in setup-phase error handling (the bare 500). All three were findable at write-time with a stronger "is this actually right under the real production lifecycle?" review pass. That's the working-with-AI discipline I'd raise.

  ## One-page summary

**Core claim:** the 2026 meta-question isn't a trap. The strong answer is grounded: matter-of-fact about AI's role, framework-based about *how* AI shaped each decision (deliberate / evaluated-and-accepted / defaulted-to), and honest about which defaulted-to decisions became real bugs.

**Questions covered:**
- *"Did you use AI?"* → yes, table stakes; three-mode framework for how AI shaped decisions.
- *"What did AI get wrong?"* → lead with `insights.ts` concurrent-user wipe (AI wrote, I accepted, I read as bug, shipped fix). Three other bugs on deck.
- *"Explain this section line by line"* → walk `aptkit-adapters.ts`: three classes, ~200 LOC, library owns loop, Blooming owns boundary.
- *"PKCE flow?"* → defaulted-to; rough mechanism known (binds token exchange to initiator); deep threat model ceded honestly.

**Pull quotes:**
```
┃ "Three modes: deliberate, evaluated-and-accepted,
┃  defaulted-to. All three are legitimate. The senior
┃  move is knowing which decisions are in which mode."
```
```
┃ "AI wrote this, I accepted it, I later read it as
┃  a real bug, here's the fix and it shipped."
```

**What you'd change:** treat the first review of any AI-scaffolded state, lifecycle, or concurrency code as a deliberate code review pass, not "looks reasonable, ship it." Three of four bugs in this chapter were findable at write-time with that discipline.
