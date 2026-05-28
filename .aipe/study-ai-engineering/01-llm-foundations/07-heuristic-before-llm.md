# Heuristic before LLM (the free path before the paid path)

**Industry name(s):** heuristic-before-LLM, cheap-path-first / fast-path routing, deterministic pre-filter
**Type:** Industry standard · Language-agnostic

> Intent routing has two layers: `parseIntent` is a pure substring heuristic with zero cost and zero latency, and `classifyIntent` is the haiku LLM fallback — and the route itself runs a heuristic branch (presence of `q`) before any model call at all.

**See also:** → 06-token-economics.md · → 03-sampling-parameters.md · → 08-provider-abstraction.md · → 01-what-an-llm-is.md

---

## Why care

Before you fire a network request to validate an email, you run `value.includes('@')`. The regex is free, instant, and catches the obvious failures; the network call is slow and costs a request, so you only make it when the cheap check passes. You do not delete the cheap check just because the network call is more thorough — you put the cheap one first precisely *because* it is cheap, and reserve the expensive one for the cases the cheap one cannot resolve.

An LLM call is the expensive network request of this story. The question is: before you pay tokens and latency to ask a model, is there a free deterministic check that resolves the easy cases?

**The pivot: an LLM call is the most expensive way to answer a question, so a cheap deterministic check belongs in front of it whenever one exists.** Tokens cost money, model calls add latency, and their output is non-deterministic and needs validation (→ 01-what-an-llm-is.md). A substring match costs nothing, returns instantly, and is perfectly deterministic. If a substring match can answer the question, the model call is pure waste.

Before the fast-path discipline:
- Every intent decision pays for an LLM round-trip, even "show me monitoring" which is unambiguous
- A typo in the question still triggers a paid classification
- Latency and cost scale with request volume linearly

After:
- The free heuristic resolves the obvious cases instantly
- The paid model is reserved for genuinely ambiguous free-form queries
- Cost and latency drop for the common, easy inputs

It is `value.includes('@')` before the verification API — applied to LLM routing.

---

## How it works

**Mental model.** Two functions, same return type, ordered cheapest-first. `parseIntent(raw): Intent` is a pure string function — no network, no model, no async. `classifyIntent(anthropic, query): Promise<Intent>` is the LLM. The system reaches for the model *only* when the cheap function cannot decide, and even `classifyIntent` runs its model output back through `parseIntent` to normalize it. The cheap path is both the pre-filter and the post-parser.

```
question: "what intent is this query?"
      │
  ┌───▼──────────────────────────┐
  │ parseIntent (pure, free)      │  substring match
  │ includes("monitoring")? ...   │
  └───┬───────────────────────────┘
      │ decisive?  ── yes ──▶ return Intent   (no model call)
      │ no / ambiguous
      ▼
  ┌──────────────────────────────┐
  │ classifyIntent (haiku, paid)  │  LLM round-trip
  │ → text → parseIntent(text)    │  ← cheap path normalizes the output
  └───┬───────────────────────────┘
      ▼
   Intent
```

The free path is tried first and reused to interpret the paid path's answer. The model is the fallback, not the default.

---

### The heuristic: `parseIntent`

`parseIntent` (`lib/agents/intent.ts` L6–L12) is a pure function: lowercase the input and substring-match against the three intent keywords, defaulting to `'diagnostic'`:

```typescript
export function parseIntent(raw: string): Intent {
  const t = raw.trim().toLowerCase();
  if (t.includes('monitoring')) return 'monitoring';
  if (t.includes('recommendation')) return 'recommendation';
  if (t.includes('diagnostic')) return 'diagnostic';
  return 'diagnostic';
}
```

Zero cost, zero latency, fully deterministic. It serves two roles: a fast classifier for inputs that literally contain an intent word, and — critically — the *parser for the LLM's output*. When the haiku model replies "monitoring", `parseIntent("monitoring")` turns that string into the typed `Intent`. The cheap function is the boundary parser for the expensive function (the same parse-the-output discipline as → 01-what-an-llm-is.md and → 04-structured-outputs.md).

```
parseIntent("show me monitoring")  → 'monitoring'   (heuristic hit, no model)
parseIntent("why did sales drop?") → 'diagnostic'   (default — no keyword)
parseIntent(<haiku output "monitoring">) → 'monitoring'  (normalize LLM text)
```

---

### The LLM fallback: `classifyIntent`

`classifyIntent` (`lib/agents/intent.ts` L17–L31) is the paid path for genuinely free-form queries that contain no literal intent keyword. It calls haiku with `max_tokens: 16` and a one-word system prompt, then feeds the result through `parseIntent`:

```typescript
export async function classifyIntent(anthropic: Anthropic, query: string): Promise<Intent> {
  const res = await anthropic.messages.create({
    model: CLASSIFIER_MODEL,           // haiku — cheap
    max_tokens: 16,                     // one word
    system: 'Classify the user query as exactly one word: monitoring ... diagnostic ... recommendation ...',
    messages: [{ role: 'user', content: query }],
  });
  const text = res.content.filter(...text...).join('');
  return parseIntent(text);             // ← cheap path normalizes the answer
}
```

This is the LLM doing what the substring heuristic cannot: understanding that "why did sales drop?" is *diagnostic* intent even though it contains none of the keywords. The model is on the cheap haiku tier (→ 06-token-economics.md) and capped to one word — the least expensive way to get a model's judgment.

---

### The route's own heuristic branch

Before any classification at all, the route runs a free structural check: which flow to enter, based purely on *which query parameters are present* (`app/api/agent/route.ts` L135 and L145):

```
GET /api/agent
  q present, no insightId  → query flow:  classifyIntent → QueryAgent.answer
  insightId present        → investigation flow: DiagnosticAgent → RecommendationAgent
  neither                  → 400  (route.ts L55–57)
```

The `q && !insightId` test (L135) is a heuristic — presence of a parameter — that decides the entire downstream path with zero model involvement. The expensive `classifyIntent` call (L136) runs *only inside* the query branch, only after the free structural check has already routed the request. Two layers of fast-path: structural routing (free) then keyword routing (free) then, last, the model.

```
┌─ route: parameter-presence heuristic (free) ─┐
│  q? insightId?  → pick the flow              │
└──────────────┬───────────────────────────────┘
               │ query flow only
        ┌──────▼─────────────────────────┐
        │ parseIntent-style keyword (free)│  (implicit in classifyIntent's parse)
        │      → classifyIntent (haiku)   │  ← paid, last resort
        └─────────────────────────────────┘
```

---

### The principle

Order your routing checks cheapest-first and reserve the model for what only a model can do. A substring match and a parameter-presence test cost nothing and resolve the unambiguous cases; the LLM is the fallback for genuine ambiguity. blooming insights layers three checks — parameter presence, keyword substring, haiku classification — so the paid path runs only when the two free paths cannot decide, and even then the free parser normalizes the paid path's output.

---

## Heuristic before LLM — diagram

This diagram spans the route (structural heuristic) and the intent layer (keyword heuristic → LLM fallback). The free checks gate the paid call; a reader who sees only this should grasp that the model is the last resort, not the first move.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER — fast paths first                                    │
│                                                                       │
│  app/api/agent/route.ts                                              │
│    heuristic: parameter presence  (FREE)                            │
│      q && !insightId ? query flow : investigation flow   L135/L145  │
│              │ query flow                                            │
│              ▼                                                       │
│  lib/agents/intent.ts                                                │
│    parseIntent(raw)  (FREE, pure)            L6–12                   │
│      includes("monitoring"|"recommendation"|"diagnostic")?          │
│              │ decisive ── yes ──▶ Intent  (NO model call)           │
│              │ no                                                    │
└──────────────┼────────────────────────────────────────────────────────┘
               │  only here do we pay
┌──────────────▼────────────────────────────────────────────────────────┐
│  PROVIDER LAYER — paid path (last resort)                           │
│                                                                       │
│  classifyIntent → haiku, max_tokens 16       intent.ts L17–31        │
│    res.content text ──▶ parseIntent(text)  ← FREE parser normalizes  │
│              │                                                       │
│              ▼                                                       │
│           Intent                                                     │
└────────────────────────────────────────────────────────────────────────┘
```

The free heuristics gate the call; the model only runs for free-form queries with no literal keyword, and the free parser even interprets the model's answer.

---

## In this codebase

### Files, functions, and line ranges

- **The heuristic:** `parseIntent(raw)` — `lib/agents/intent.ts` L6–L12. Pure, lowercase + substring match, default `'diagnostic'`.
- **The LLM fallback:** `classifyIntent(anthropic, query)` — `lib/agents/intent.ts` L17–L31. Haiku, `max_tokens: 16` (L20), output normalized via `parseIntent` (L30).
- **The cheap model tier:** `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'` — `lib/agents/intent.ts` L14 (vs sonnet `AGENT_MODEL`, `lib/agents/base.ts` L9).
- **The route's structural heuristic:** parameter-presence branch — `app/api/agent/route.ts` L135 (`q && !insightId` → query flow), L145 (investigation flow), L55–L57 (neither → 400); `classifyIntent` invoked only inside the query branch at L136.

### Why two layers, not one

`parseIntent` alone would mis-route every natural-language question, because real users do not type the word "diagnostic" — they type "why did sales drop?" `classifyIntent` alone would pay for a model call on every routing decision, including the unambiguous "show me monitoring." Layering them captures the cheap wins (literal keywords, parameter presence) for free and pays for the model only on the inputs that need understanding. The reuse of `parseIntent` to parse the model's output means there is one canonical mapping from string to `Intent`, whether the string came from a user or from haiku.

---

## Elaborate

### Where this pattern comes from

"Cheap check before expensive check" is one of the oldest optimizations in systems: a Bloom filter before a disk read, a CDN cache before an origin hit, a `WHERE` clause's cheapest predicate evaluated first, short-circuit boolean evaluation. The LLM era added a new "expensive check" — the model call — to the top of the cost hierarchy, because it is slow, paid, *and* non-deterministic. The pattern is unchanged; only the relative cost of the expensive path went up.

In LLM routing specifically, this is the foundation of *cascade* or *cost-aware routing*: try the cheapest resolver (rules → small model → large model), escalating only on failure or ambiguity. The two-function `parseIntent` / `classifyIntent` split is the minimal version of a cascade.

### The deeper principle

```
resolver               cost      determinism   coverage
─────────────────────  ────────  ────────────  ──────────────────────
substring heuristic    free      total         literal keywords only
haiku LLM              cheap     non-det.       free-form understanding
sonnet agent           dear      non-det.       full reasoning + tools
```

Each tier covers what the cheaper tier cannot, at higher cost. The art is putting the boundary in the right place: `parseIntent` handles the keyword cases; `classifyIntent` handles the natural-language cases; neither tries to do the other's job. Pushing more onto the free tier saves money but risks mis-routing; pushing more onto the model is correct but wasteful.

### Where this breaks down

1. **The heuristic can mis-classify silently.** A user query like "stop *monitoring* my spend" contains "monitoring" but is not a monitoring-intent question — `parseIntent` would route it wrong with full confidence, and there is no signal that the cheap path made a low-quality decision. This is the classic drift risk of heuristics: they are confident even when wrong.

2. **The `'diagnostic'` default is a guess.** When no keyword matches and `parseIntent` is used directly, it defaults to diagnostic (`lib/agents/intent.ts` L11) — a reasonable bias (most questions are "why"), but a bias nonetheless. In the route's query flow this is masked because `classifyIntent` runs first; using `parseIntent` standalone inherits the default's risk.

3. **Heuristics rot as inputs evolve.** The substring list is fixed. If a fourth intent is added, or users start phrasing monitoring questions without the word, the heuristic silently degrades while the LLM fallback keeps working — the heuristic's coverage shrinks invisibly over time.

### What to explore next

- **Confidence-gated cascade:** have `classifyIntent` return a confidence and only trust the haiku answer above a threshold, escalating ambiguous cases to a stronger model — a fuller cost cascade.
- **Logging heuristic-vs-LLM agreement:** record how often `parseIntent` and `classifyIntent` would disagree to detect heuristic drift (ties into the absent observability in → 06-token-economics.md).
- **Regex / embedding pre-filters:** richer cheap-path classifiers (regex patterns, a tiny embedding nearest-neighbor) that extend the free tier's coverage beyond literal substrings.

---

## Tradeoffs

### Heuristic-then-LLM cascade vs. LLM-always vs. heuristic-only

| Dimension | This codebase (heuristic → haiku) | LLM-always (classify everything) | Heuristic-only |
|---|---|---|---|
| Cost on easy inputs | Free (heuristic resolves) | Paid model call every time | Free |
| Cost on free-form inputs | One cheap haiku call | One cheap haiku call | Free but mis-routes |
| Determinism on keyword inputs | Total | Non-deterministic | Total |
| Coverage of natural language | Full (LLM fallback) | Full | Poor — keywords only |
| Failure mode | Heuristic mis-match on tricky phrasing | Cost + latency on every call | Silent mis-routing |
| Maintenance | Keep keyword list current | None | Keyword list rots fastest |

**What we gave up.** Perfect routing on adversarial phrasing. The substring heuristic will confidently mis-route "stop monitoring my spend," and the `'diagnostic'` default is a bias, not a decision. The cheap path trades a small mis-classification risk for zero cost on the common cases — acceptable because mis-routing sends the query to a *different capable agent*, not to a crash.

**What the alternative would have cost.** LLM-always would pay a haiku call on every routing decision including the unambiguous ones — small per call, linear in volume, and slower. Heuristic-only would be free but would mis-route every natural-language question (the majority of real queries), which is the opposite failure: cheap and wrong.

**The breakpoint.** Heuristic-first is right while the easy cases are common and the heuristic's mis-classification rate is low. It breaks when either the input distribution shifts (users stop using keywords, so the free tier's coverage collapses) or mis-routing becomes costly (a wrong route triggers an expensive wrong investigation). At that point you either enrich the cheap tier (regex, embeddings) or gate it on measured agreement with the LLM — which requires the agreement logging the codebase does not yet have.

---

## Tech reference (industry pairing)

### substring heuristic (`parseIntent`)

- **Codebase uses:** `lib/agents/intent.ts` L6–L12 — pure lowercase + `includes` match, default `'diagnostic'`.
- **Why it's here:** a free, deterministic resolver for literal-keyword inputs and the canonical parser for the LLM's one-word output.
- **Leading today:** rule/keyword pre-filters remain the standard free tier in LLM routing cascades (2026).
- **Why it leads:** zero cost and total determinism on the cases it covers; nothing beats free.
- **Runner-up:** regex classifiers — richer patterns, still free, more maintenance.

### cheap-model LLM classifier (`classifyIntent` on haiku)

- **Codebase uses:** `lib/agents/intent.ts` L17–L31 — haiku, `max_tokens: 16`, output re-parsed by `parseIntent`.
- **Why it's here:** to understand natural-language queries the substring heuristic cannot, at the lowest model cost.
- **Leading today:** small-model classification (haiku-class, or fine-tuned tiny models) is the standard second tier (2026); RouteLLM-style cascades formalize the escalation.
- **Why it leads:** captures most natural-language routing at a fraction of the large-model cost.
- **Runner-up:** an embedding nearest-neighbor classifier — no per-call model cost after indexing, less flexible on novel phrasing.

### parameter-presence routing (the route's structural heuristic)

- **Codebase uses:** `app/api/agent/route.ts` L135 / L145 — branch on `q` vs `insightId`.
- **Why it's here:** the entire flow choice is decidable from request shape, with no model needed.
- **Leading today:** structural request routing is universal (2026) — it is just controller logic, not AI.
- **Why it leads:** the cheapest possible router; the model never sees requests it cannot help.
- **Runner-up:** an LLM router that reads the whole request — strictly worse when the shape already decides it.

---

## Project exercises

### Log heuristic-vs-LLM agreement to detect drift

- **Exercise ID:** B1.5 (adapted) — heuristic-before-LLM observability.
- **What to build:** in the query flow, run `parseIntent(q)` alongside `classifyIntent(q)` and record when they disagree, so you can measure the heuristic's mis-classification rate over real traffic.
- **Why it earns its place:** shows you understand heuristics drift silently and that the way to catch it is to measure agreement with the more capable resolver.
- **Files to touch:** `app/api/agent/route.ts` (compute both in the query branch near L136), a small log sink (e.g. extend the future `ai-call-log.ts` from → 06-token-economics.md).
- **Done when:** running a batch of varied queries produces a disagreement rate, and a phrasing like "stop monitoring my spend" shows up as a heuristic/LLM mismatch.
- **Estimated effort:** 1–4hr

### Add a regex tier between substring and the LLM

- **Exercise ID:** B1.8 (adapted) — extend the free tier's coverage.
- **What to build:** insert a small regex-pattern classifier between `parseIntent`'s substring check and the haiku fallback (e.g. "why|cause|because" → diagnostic, "should I|recommend|what action" → recommendation), so more queries resolve for free.
- **Why it earns its place:** demonstrates you can widen the cheap tier deliberately and measure how many model calls it eliminates.
- **Files to touch:** `lib/agents/intent.ts` (new regex layer, kept pure), `test/agents/intent.test.ts`.
- **Done when:** a set of keyword-free natural-language queries resolves via the regex tier without a model call, and the LLM fallback still covers the rest.
- **Estimated effort:** 1–4hr

---

## Summary

The cheapest way to answer a routing question beats the model, so blooming insights puts free deterministic checks in front of the paid LLM. `parseIntent` (`lib/agents/intent.ts` L6–L12) is a pure substring heuristic that resolves literal-keyword inputs at zero cost and also parses the LLM's one-word output; `classifyIntent` (L17–L31) is the haiku fallback for free-form queries the heuristic cannot understand; and the route's parameter-presence branch (`app/api/agent/route.ts` L135) decides the entire flow before any model call. The model is the last resort, reserved for genuine ambiguity — and even its answer is normalized by the free parser.

**Key points:**
- An LLM call is the most expensive resolver — slow, paid, non-deterministic — so a free deterministic check belongs in front of it.
- `parseIntent` is both the fast classifier *and* the parser for `classifyIntent`'s output (one canonical string→Intent mapping).
- The route routes by parameter presence before any classification runs.
- Heuristics are confidently wrong on tricky phrasing ("stop monitoring my spend") and drift as inputs evolve — the cheap path's risk.
- The cascade puts the boundary where it belongs: keywords free, natural language to the cheap model, never the expensive model for routing.

---

## Interview defense

### What an interviewer is really asking

"How do you decide when to call the model?" tests whether you treat the LLM as a default or a last resort. The senior signal is naming the free checks that gate it and acknowledging the heuristic's drift risk — not pretending the substring match is flawless.

### Likely questions

**[mid] How does the system route a query without always paying for a model call?**

Two free checks first. The route branches on parameter presence (`q` vs `insightId`, `app/api/agent/route.ts` L135). Inside the query flow, `parseIntent` (`lib/agents/intent.ts` L6–L12) resolves any input containing a literal intent keyword for free. Only genuinely free-form queries reach `classifyIntent` (the haiku call).

```
param presence (free) → parseIntent keyword (free) → classifyIntent (paid, last)
```

**[senior] `parseIntent` is just `String.includes`. Why keep it when you have a classifier?**

Because it is free, instant, deterministic, and it doubles as the parser for the classifier's output (`lib/agents/intent.ts` L30). The classifier alone would pay a model call on every routing decision, including unambiguous ones; the heuristic captures those for free. The tradeoff is that the heuristic can mis-route tricky phrasing — but a mis-route sends the query to a different *capable* agent, not to a failure.

```
"show me monitoring" → parseIntent → 'monitoring'   (no model, no cost)
"why did sales drop?" → no keyword → classifyIntent  (pay only here)
```

**[arch] What's the failure mode of the heuristic, and how would you detect it?**

Silent mis-classification — "stop monitoring my spend" matches "monitoring" but is not monitoring intent, and the heuristic is confident. Heuristics also rot as phrasing evolves. Detect it by logging where `parseIntent` and `classifyIntent` disagree over real traffic and watching that rate — the agreement signal that tells you the free tier is drifting.

```
heuristic confident + wrong → no signal today
fix: log parseIntent vs classifyIntent disagreement → drift visible
```

### The question candidates always dodge

**"When is the heuristic wrong, and how would you know?"** The honest answer: it is confidently wrong on inputs that contain a keyword in a non-intent sense, and today there is *no signal* — nothing compares it to the LLM. A candidate who claims the substring match is reliable is ignoring its drift risk; the real answer names the failure and the missing measurement.

### One-line anchors

- `lib/agents/intent.ts` L6–L12 — `parseIntent`, free substring heuristic + LLM-output parser.
- `lib/agents/intent.ts` L17–L31 — `classifyIntent`, the haiku fallback, output re-parsed at L30.
- `app/api/agent/route.ts` L135 — parameter-presence routing before any model call.
- `lib/agents/intent.ts` L14 — haiku tier for the paid path (cheap, → 06-token-economics.md).
- Heuristic risk: confidently wrong on tricky phrasing; drifts as inputs evolve.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the three-layer routing cascade: parameter-presence (route), keyword substring (`parseIntent`), haiku classification (`classifyIntent`). State which are free, which is paid, and where `parseIntent` is reused.

### Level 2 — Explain

Out loud: why does `classifyIntent` feed its model output back through `parseIntent` (`lib/agents/intent.ts` L30)? What single guarantee does reusing the heuristic as the parser provide?

### Level 3 — Apply

Scenario: a user types "stop monitoring my spend." Trace it through `parseIntent` (`lib/agents/intent.ts` L6–L12). What does it return, is that correct, and what signal would have told you the heuristic made a low-quality call? Tie the answer to the disagreement-logging idea.

### Level 4 — Defend

A colleague wants to delete `parseIntent` and "just always call the classifier — it's smarter." Argue the cost and latency case for keeping the free tier, and name the one situation where the colleague is actually right (the heuristic's coverage collapsing as inputs evolve).

### Quick check — code reference test

What does `parseIntent` return for an input with no intent keyword, and where is that default set? (Answer: `'diagnostic'` — `lib/agents/intent.ts` L11, the final `return 'diagnostic'`.)
