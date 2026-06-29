# Chapter 5 — The failure story

  ## Opening hook

The scale chapter was about *what* breaks first under load. This chapter is about *what your system does* when something breaks at all. Different question. Scale is the curve; failure is the cliff. The interviewer who asks "what happens when X goes wrong" is testing whether you treat failure as a first-class output or as an afterthought you patched over.

Most candidates treat failure handling as a stack of try/catch blocks. That's the weak shape. The strong shape is naming a *failure surface* — the boundary where something can go wrong — and saying what *travels back to the user* across that surface, on that exact failure. In this app the boundaries are clear: the OAuth dance to the alpha MCP server, the rate-limited tool call, the streaming response, malformed tool results, partial writes to in-memory state. Each gets a specific answer.

The picture below is the failure-surface map. Walk it once, then walk each surface in the body.

  ## The picture you draw — the failure-mode map

```
  Failure surfaces — what happens at each boundary when it gives way

  ┌─ UI ─────────────────────────────────────────────────────────┐
  │  StrictMode double-fetch (dev) → guard at useInvestigation   │
  │  network drop mid-stream     → reader breaks, "reconnect"    │
  │  malformed NDJSON line       → readNdjson swallows, continues │
  └──────────────────────────────────────────────────────────────┘
                            │ NDJSON over fetch
                            ▼
  ┌─ Service ────────────────────────────────────────────────────┐
  │  setup throw before stream → bare 500 (PROD-ONLY 500 BUG)    │
  │     → fix: wrap setup INSIDE the stream; emit error event    │
  │  agent loop maxTurns hit  → forced final synthesis turn      │
  │  AbortError mid-stream    → real cancellation event          │
  └──────────────────────────────────────────────────────────────┘
                            │ DataSource.callTool
                            ▼
  ┌─ DataSource (Bloomreach) ────────────────────────────────────┐
  │  token revoked (minutes) → invalid_token error event,        │
  │     UI auto-reconnect (guarded, one-shot)                     │
  │  rate-limit 429           → McpClient retry with backoff      │
  │  malformed MCP envelope  → unwrap() prefers structuredContent │
  │     else content[0].text; result rides through                │
  │  tool throws server-side → toolResult.isError=true,           │
  │     loop carries is_error:true back to model                  │
  └──────────────────────────────────────────────────────────────┘
                            │
                            ▼
                  Bloomreach loomi connect (alpha)
                  rate-limited · revokes tokens · sometimes 500s
```

Five surfaces. Each row is a real failure mode with a real handler. The boxes are the layer that catches it; the arrows are what travels back up. The reader who memorizes this picture has the whole chapter.

  ## The body — the failure surfaces walked

  ### Failure 1 — the bare 500 (the prod-only setup failure)

This is the gold-thread failure story for this chapter, because it isn't a single failure — it's a class of failure (setup-phase exception in a streaming app) that you only saw once it bit you in production.

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "What happens if the agent loop fails before the stream   │
  │    even starts?"                                            │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you understand the failure mode of a streaming app?    │
  │   Where does an exception thrown during setup go? Have you  │
  │   actually shipped a streaming endpoint and watched what    │
  │   the user sees when it breaks?                             │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "There's a specific bug here that taught me to think about this differently. In prod, `aesKey()` in `lib/mcp/auth.ts` throws when `AUTH_SECRET` is unset — and that throw used to happen during pre-stream setup, unguarded. Demo mode worked fine because it doesn't touch auth. Live mode worked locally because my dev env had the secret. In prod live, the route returned a bare 500 with no body, and the UI's only honest message was 'something went wrong.'
>
> The isolation by contrast is what made this teach a real lesson. Demo returned 200. Live returned 500. The only difference was the setup path. So the bug wasn't in the agent loop; it was in *where setup ran*.
>
> The fix was to wrap setup in try/catch *inside* the stream, so any setup error becomes a real NDJSON error event with a real message — the UI renders the actual problem and shows a reconnect button on auth errors. Now the streaming contract is the *only* output surface; every failure rides through it. There is no way to fail this app where the user sees a bare 500."

```
  ┃ "There is no way to fail this app where the user
  ┃  sees a bare 500. Every failure rides through the
  ┃  streaming contract."
```

  ### Failure 2 — token revocation mid-session

The alpha Bloomreach server revokes tokens after minutes. This isn't a bug; it's a constraint of the substrate.

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Your session token is revoked mid-briefing — what happens │
  │    on the user's screen?"                                    │
  │                                                              │
  │ WHAT THEY'RE TESTING                                         │
  │   Do you handle auth as a first-class failure mode, or only │
  │   as a happy-path concept? Do you know what your              │
  │   reconnect-loop looks like and what protects you from it    │
  │   looping forever?                                            │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "The MCP server returns an `invalid_token` error inside the tool-call result. The agent loop's adapter sees that, the trace sink emits a `tool_call_end` with the error, and the route handler turns it into an `error` NDJSON event on its way back up. The UI hook recognizes the `invalid_token` shape, hits `/api/mcp/reset` to clear the OAuth cookie, and reloads the page once.
>
> The 'once' is the protection. There's a guard in the reconnect path so a permanently-broken auth state can't loop the page forever. After one auto-reconnect attempt, the user sees the auth error rendered as a real card with a reconnect button. They drive the next attempt manually.
>
> Cost I'm paying: the briefing the user was on is lost. I don't resume mid-stream; I restart. For an alpha server that revokes tokens roughly every few minutes, this is the right tradeoff — implementing mid-stream resume is significant code for a constraint that goes away once the server's auth lifetime extends."

```
  ┌─────────────────────────┬─────────────────────────────────┐
  │ WEAK ANSWER             │ STRONG ANSWER                   │
  ├─────────────────────────┼─────────────────────────────────┤
  │ "The session times out  │ "MCP returns invalid_token in   │
  │  and the user re-       │  the tool result. Loop surfaces │
  │  authenticates. Pretty  │  it as an error event. UI       │
  │  standard."             │  resets auth via /api/mcp/reset │
  │                         │  and reloads ONCE — guard       │
  │                         │  prevents infinite reload. User │
  │                         │  loses the briefing in flight;  │
  │                         │  trade I made for an alpha       │
  │                         │  server."                       │
  ├─────────────────────────┼─────────────────────────────────┤
  │ Why it's weak: "pretty  │ Why it works: names the path     │
  │ standard" hides that    │ the error travels (tool result  │
  │ you didn't actually     │ → loop → NDJSON → UI), the      │
  │ ship the reconnect      │ guard against infinite reload,  │
  │ behavior. Generic       │ the cost owned. Specific.       │
  │ language signals you    │                                 │
  │ haven't done it.        │                                 │
  └─────────────────────────┴─────────────────────────────────┘
```

  ### Failure 3 — rate-limit overrun on Bloomreach

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "An agent runs so many tool calls it hits the Bloomreach   │
  │    rate limit. What happens?"                                │
  │                                                              │
  │ WHAT THEY'RE TESTING                                         │
  │   Do you have a real strategy at the rate-limit boundary,   │
  │   or do you let the upstream propagate? Do you know the     │
  │   difference between retry and fail?                         │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "Two layers of handling. First, `BloomreachDataSource` paces calls at roughly 1.1 seconds between requests — that's a floor I picked to stay under the alpha server's ~1 req/s soft limit with a safety margin. Most agent runs never see a 429 because of this pacing alone.
>
> Second, when a 429 does come back — usually because the bucket is shared across whatever else is hitting Bloomreach in the same window — `McpClient` retries with backoff. The retry is bounded; after a few attempts it surfaces a real error rather than spinning. The agent loop sees `toolResult.isError = true` and the model gets a tool result with `is_error: true` in its history. Anthropic's models handle that — they typically pivot to a different tool or give up the line of inquiry rather than retrying the same call.
>
> What I don't do: I don't queue across users. The rate-limit bucket is a shared external resource. If two users both trigger briefings and burn through the budget concurrently, both runs degrade — neither gets prioritized."

  ### Failure 4 — malformed tool result from MCP

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "An MCP tool returns something that doesn't match the      │
  │    schema your agent expects. What happens?"                 │
  │                                                              │
  │ WHAT THEY'RE TESTING                                         │
  │   Do you trust the boundary? Or do you treat it as adversarial│
  │   the way a senior engineer should?                          │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "Two defenses. First, the MCP envelope is opinionated — `lib/mcp/schema.ts` has an `unwrap()` helper that prefers `structuredContent` (the typed payload) over `content[0].text` (the freeform fallback). If neither is present, it returns null and the agent gets a null result it can handle.
>
> Second, the agents don't blindly trust what comes back. Each agent has prompts that ask the model to verify the shape it's reasoning over — and at the route handler boundary, every output the agent emits gets validated against the `AgentEvent` schema before going on the NDJSON wire. A bad event from the model gets dropped with a logged warning rather than poisoning the UI stream.
>
> What this misses: schema *evolution*. If Bloomreach adds a new field to a tool result, my unwrap doesn't break — it just ignores the field. If they *remove* a field the agent expected, the agent's prompt may keep referencing a field that's no longer there, and the response degrades quietly. I don't have a cross-version contract test against the live MCP today. That's a gap."

```
  ┃ "The MCP envelope is opinionated. The boundary
  ┃  validates. The agent doesn't blindly trust the wire."
```

  ### Failure 5 — AbortError from a cancelled fetch under StrictMode

This is the user-visible failure that taught you something specific about React 19's development semantics — it deserves its own section because it's a senior-signal answer.

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "What happens when a user navigates away mid-investigation?"│
  │                                                              │
  │ WHAT THEY'RE TESTING                                         │
  │   Have you thought about lifecycle? Do you understand the    │
  │   difference between StrictMode's intentional double-render  │
  │   and a real lifecycle event?                                │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "There's a real bug story here. The hook is `useInvestigation`. Originally it had both an effect guard (so duplicate fetches couldn't fire under StrictMode's intentional double-mount) and a cleanup that aborted the in-flight fetch when the effect tore down. Under StrictMode in development, those two were solving for *different lifetimes*. The cleanup aborted the only fetch I had. The guard then blocked the second mount from re-firing it. The UI showed nothing — silent failure.
>
> The fix was to keep the guard, drop the cancel-on-cleanup. The guard protects against a double fetch; the cancel protects against a leaked one. Under StrictMode they were solving for different lifetimes — the guard was the right one to keep.
>
> Now if the user really navigates away (a true unmount, not StrictMode's dev-only double mount), the fetch completes silently in the background. The browser tears down the render tree; the response data is GC'd. The Bloomreach tool calls that were in-flight do still run on the server — that's the rate-limit waste I called out in the architecture chapter as the cancellation-chain gap.
>
> The comment in `lib/hooks/useInvestigation.ts` explicitly says: *survives StrictMode by NOT cancelling the in-flight fetch on cleanup*. That comment is the receipt for the bug fix."

  ## When you don't know

The interviewer can push you into operating-system level fault tolerance — what happens if the Vercel function gets OOM-killed, how do you handle a partial write to a stream that's already been seen, what's your durability story for in-flight work. You did not design for any of that.

```
  ╔═══════════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                           ║
  ║                                                               ║
  ║   They ask: "What happens if the Vercel function gets OOM-    ║
  ║   killed mid-briefing? How do you handle a partial write?"    ║
  ║                                                               ║
  ║   You don't have a durability story for in-flight work. The   ║
  ║   briefing is ephemeral. If the function dies, the run is     ║
  ║   gone.                                                        ║
  ║                                                               ║
  ║   Say:                                                        ║
  ║   "I don't have a durability story for in-flight work. The    ║
  ║    briefing is ephemeral by design — no persistence layer,    ║
  ║    so if the function gets OOM-killed or hits maxDuration     ║
  ║    mid-stream, the user sees the stream cut off and has to    ║
  ║    re-run. The cost I'm paying for the no-DB design includes  ║
  ║    no resume. The fix would be the same lever as 'persisted   ║
  ║    insights' — once that becomes a real requirement, I'd add  ║
  ║    a persistence layer and durable run records that survive   ║
  ║    function death. Right now neither is on. If you wanted to  ║
  ║    walk what that would look like, I'd start by checkpointing │
  ║    the agent loop's tool-call history."                       ║
  ║                                                               ║
  ║   What this signals: honest about the design boundary,        ║
  ║   names where the trigger is, offers a concrete sketch of     ║
  ║   what you'd build. No fake confidence; no panic.             ║
  ║                                                               ║
  ║   Do NOT say:                                                 ║
  ║   "Yeah, the function would restart and we'd resume from      ║
  ║    where we left off..." — confabulating a recovery story     ║
  ║   you didn't build is the worst move. Senior interviewers     ║
  ║   read the code; they'll check.                               ║
  ╚═══════════════════════════════════════════════════════════════╝
```

  ## What you'd change

If you were redoing the failure story today, the one change you'd reach for first is **a cross-version contract test against the live Bloomreach MCP** — something that runs nightly against the alpha server and asserts that each tool you depend on still returns the schema your agents reason over. Today, schema drift on the Bloomreach side degrades the agent output quietly. The user sees vaguer answers, not an error. A contract test surfaces the drift as a real failure before a user does. The cost is one more CI dependency on the alpha server, which is real.

  ## One-page summary

**Core claim:** failures travel through the streaming contract. There is no way to fail this app where the user sees a bare 500 — every failure surface emits a real, parseable event the UI can render.

**Questions covered:**
- *Setup throws before the stream starts?* → bug story: the prod-only 500 from `aesKey()`. Fix: wrap setup inside the stream.
- *Token revoked mid-session?* → `invalid_token` → error event → UI resets auth via `/api/mcp/reset` and reloads ONCE (guarded). Briefing in flight is lost — owned cost.
- *Rate-limit overrun?* → ~1.1s pacing first; `McpClient` retries with backoff; surfaces `isError = true` to the model; no cross-user queueing.
- *Malformed tool result?* → `unwrap()` prefers `structuredContent` over `content[0].text`; agent events validated at route boundary. Gap: no schema-drift contract test.
- *Navigate away mid-investigation?* → bug story: StrictMode double-fetch. Guard kept, cleanup cancel dropped. Real unmount = silent completion; in-flight Bloomreach call still runs (rate-limit waste).
- *OOM kill / partial write?* → no durability story for in-flight work; cost of no-DB design. Trigger to add: persisted briefings.

**Pull quotes:**
```
┃ "There is no way to fail this app where the user
┃  sees a bare 500. Every failure rides through the
┃  streaming contract."
```
```
┃ "The MCP envelope is opinionated. The boundary
┃  validates. The agent doesn't blindly trust the wire."
```

**What you'd change:** a nightly cross-version contract test against the live Bloomreach MCP, so schema drift surfaces as a real failure before the user sees vaguer agent answers.
