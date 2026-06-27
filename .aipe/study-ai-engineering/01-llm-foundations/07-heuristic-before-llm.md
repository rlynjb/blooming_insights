# Heuristic before LLM (the free path before the paid path)

**Industry name(s):** heuristic-before-LLM, cheap-path-first / fast-path routing, deterministic pre-filter
**Type:** Industry standard · Language-agnostic

> Intent routing has two layers: `parseIntent` is a pure substring heuristic with zero cost and zero latency, and `classifyIntent` is the haiku LLM fallback — and the route itself runs a heuristic branch (presence of `q`) before any model call at all.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Heuristic-before-LLM lives right at the boundary between Intent parsing (the cross-cutting `lib/agents/intent.ts`) and the Pipeline. The Route handler does the first free check (parameter-presence: `q && !insightId` at `app/api/agent/route.ts` L210); `parseIntent` (`lib/agents/intent.ts` L6–L12) does the second free check (substring); and only if neither resolves does `classifyIntent` (L17–L31) reach down through the Provider band to a haiku model call.

```
  Zoom out — where the free path sits before the paid path

  ┌─ Route handler ───────────────────────────────────┐
  │  q && !insightId ?  → query flow                   │  free heuristic #1
  │                       (route.ts L210)               │
  └─────────────────────────┬──────────────────────────┘
                            │  query flow
  ┌─ Intent parsing (cross-cutting) ────────────────────┐  ← we are here
  │  ★ parseIntent (FREE, pure)  intent.ts L6–12 ★      │
  │    includes("monitoring"|"diagnostic"|"recommendation")
  │    decisive? → return Intent  (NO model call)       │
  │    else ↓                                           │
  │  classifyIntent (PAID, haiku)  intent.ts L17–31     │
  │    res text ──▶ parseIntent(text)   ← free re-parse │
  └─────────────────────────┬──────────────────────────┘
                            │  only when free path fails
  ┌─ Provider (last resort) ▼──────────────────────────┐
  │  haiku, max_tokens 16   (cheapest possible call)    │
  └────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: before you pay tokens and latency for a model, is there a free deterministic check that resolves the easy cases? Two are layered here — parameter-presence in the route, substring match in `parseIntent` — and even the paid path's text output is normalized back through the free parser. How it works walks each layer and the drift risk that makes the heuristic confidently wrong on tricky phrasing.

---

## Structure pass

**Layers.** Three layers, each a deeper check: the route's parameter-presence branch (`q && !insightId` — free, zero ops), the pure-substring `parseIntent` (free, deterministic string predicate), and the haiku-backed `classifyIntent` (paid call, but only when the two free layers fail to decide). The classifier's output is then re-fed through `parseIntent` for normalization.

**Axis: cost.** What does each layer cost per call (latency, tokens, money), and at what point are we forced to pay? This axis pops the seam because the entire design hinges on a price gradient: route check costs nothing, substring match costs nothing, the LLM call is the first thing that costs *anything*. Control is a candidate (CODE decides at every layer), but cost is what makes the layering *worth doing* — control alone could be one giant if-ladder; cost is what forces the ordering.

**Seams.** The seam between the route's parameter check and `parseIntent` is cosmetic — both are CODE-decided, both cost zero. The load-bearing seam is between `parseIntent` and `classifyIntent`: cost flips from "free, deterministic" to "paid, probabilistic." This is the only seam where a model is reached for, and the file's whole point is that this seam is crossed *as rarely as possible*. A second cosmetic seam returns the model's output through `parseIntent` for normalization — cost doesn't flip there, but the *trust* axis briefly does (model output is re-checked by the deterministic parser).

```
  Structure pass — heuristic before LLM

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  route param check (q && !insightId)           │
  │  parseIntent (pure substring)                  │
  │  classifyIntent (haiku call — last resort)     │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  cost: what does each layer cost per call, and │
  │  when are we forced to pay?                    │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  route↔parseIntent: cosmetic (both free)       │
  │  parseIntent↔classifyIntent: LOAD-BEARING      │
  │    free deterministic → paid probabilistic     │
  │    crossed only when free path fails           │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Two functions, same return type, ordered cheapest-first. The intent parser is a pure string function — no network, no model, no async. The intent classifier is the LLM. The system reaches for the model *only* when the cheap function cannot decide, and even the classifier runs its model output back through the parser to normalize it. The cheap path is both the pre-filter and the post-parser.

```
question: "what intent is this query?"
      │
  ┌───▼──────────────────────────┐
  │ intent parser (pure, free)    │  substring match
  │ includes("monitoring")? ...   │
  └───┬───────────────────────────┘
      │ decisive?  ── yes ──▶ return Intent   (no model call)
      │ no / ambiguous
      ▼
  ┌──────────────────────────────┐
  │ intent classifier (paid)      │  LLM round-trip
  │ → text → intent parser(text)  │  ← cheap path normalizes the output
  └───┬───────────────────────────┘
      ▼
   Intent
```

The free path is tried first and reused to interpret the paid path's answer. The model is the fallback, not the default.

---

### The heuristic: the intent parser

The intent parser is a pure function: lowercase the input and substring-match against the three intent keywords, defaulting to `'diagnostic'`:

```
  function parse_intent(raw) -> Intent:
      t = lower(trim(raw))
      if t contains "monitoring":     return 'monitoring'
      if t contains "recommendation": return 'recommendation'
      if t contains "diagnostic":     return 'diagnostic'
      return 'diagnostic'    # default bias
```

Zero cost, zero latency, fully deterministic. It serves two roles: a fast classifier for inputs that literally contain an intent word, and — critically — the *parser for the LLM's output*. When the cheap-tier model replies "monitoring", the intent parser turns that string into the typed `Intent`. The cheap function is the boundary parser for the expensive function (the same parse-the-output discipline as → 01-what-an-llm-is.md and → 04-structured-outputs.md).

```
parse_intent("show me monitoring")  → 'monitoring'   (heuristic hit, no model)
parse_intent("why did sales drop?") → 'diagnostic'   (default — no keyword)
parse_intent(<cheap-tier output "monitoring">) → 'monitoring'  (normalize LLM text)
```

---

### The LLM fallback: the intent classifier

The intent classifier is the paid path for genuinely free-form queries that contain no literal intent keyword. It calls the cheap-tier model with `max_tokens: 16` and a one-word system prompt, then feeds the result through the intent parser:

```
  async function classify_intent(provider_sdk, query) -> Intent:
      response = await provider_sdk.messages.create({
        model:       CLASSIFIER_MODEL,    # cheap tier
        max_tokens:  16,                   # one word
        system:      "Classify the user query as exactly one word: "
                     "monitoring ... diagnostic ... recommendation ...",
        messages:    [{ role: "user", content: query }],
      })
      text = join(filter(response.content, type == "text"))
      return parse_intent(text)            # cheap path normalizes the answer
```

This is the LLM doing what the substring heuristic cannot: understanding that "why did sales drop?" is *diagnostic* intent even though it contains none of the keywords. The model is on the cheap tier (→ 06-token-economics.md) and capped to one word — the least expensive way to get a model's judgment.

---

### The route's own heuristic branch

Before any classification at all, the route runs a free structural check: which flow to enter, based purely on *which query parameters are present*:

```
GET /api/agent
  q present, no insightId  → query flow:  classify_intent → query agent
  insightId present        → investigation flow: diagnostic agent → recommendation agent
  neither                  → 400
```

The `q && !insightId` test is a heuristic — presence of a parameter — that decides the entire downstream path with zero model involvement. The expensive intent-classifier call runs *only inside* the query branch, only after the free structural check has already routed the request. Two layers of fast-path: structural routing (free) then keyword routing (free) then, last, the model.

```
┌─ route: parameter-presence heuristic (free) ─┐
│  q? insightId?  → pick the flow              │
└──────────────┬───────────────────────────────┘
               │ query flow only
        ┌──────▼─────────────────────────┐
        │ parse_intent keyword (free)     │
        │      → classify_intent (paid)   │  ← paid, last resort
        └─────────────────────────────────┘
```

---

### The principle

Order your routing checks cheapest-first and reserve the model for what only a model can do. A substring match and a parameter-presence test cost nothing and resolve the unambiguous cases; the LLM is the fallback for genuine ambiguity. You layer three checks — parameter presence, keyword substring, cheap-tier classification — so the paid path runs only when the two free paths cannot decide, and even then the free parser normalizes the paid path's output.

---

### Code in this codebase

#### Files, functions, and line ranges

- **The heuristic:** `parseIntent(raw)` — `lib/agents/intent.ts` L6–L12. Pure, lowercase + substring match, default `'diagnostic'`.
- **The LLM fallback:** `classifyIntent(anthropic, query)` — `lib/agents/intent.ts` L17–L31. Haiku, `max_tokens: 16` (L20), output normalized via `parseIntent` (L30).
- **The cheap model tier:** `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'` — `lib/agents/intent.ts` L14 (vs sonnet `AGENT_MODEL`, `lib/agents/base.ts` L9).
- **The route's structural heuristic:** parameter-presence branch — `app/api/agent/route.ts` L210 (`q && !insightId` → query flow), L221 (investigation flow body; anomaly resolved at L144), L121–L123 (neither → 400); `classifyIntent` invoked only inside the query branch at L211.

#### Why two layers, not one

`parseIntent` alone would mis-route every natural-language question, because real users do not type the word "diagnostic" — they type "why did sales drop?" `classifyIntent` alone would pay for a model call on every routing decision, including the unambiguous "show me monitoring." Layering them captures the cheap wins (literal keywords, parameter presence) for free and pays for the model only on the inputs that need understanding. The reuse of `parseIntent` to parse the model's output means there is one canonical mapping from string to `Intent`, whether the string came from a user or from haiku.

---

## Heuristic before LLM — diagram

This diagram spans the route (structural heuristic) and the intent layer (keyword heuristic → LLM fallback). The free checks gate the paid call; a reader who sees only this should grasp that the model is the last resort, not the first move.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER — fast paths first                                    │
│                                                                       │
│  app/api/agent/route.ts                                              │
│    heuristic: parameter presence  (FREE)                            │
│      q && !insightId ? query flow : investigation flow /       │
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
│  classifyIntent → haiku, max_tokens 16       intent.ts               │
│    res.content text ──▶ parseIntent(text)  ← FREE parser normalizes  │
│              │                                                       │
│              ▼                                                       │
│           Intent                                                     │
└────────────────────────────────────────────────────────────────────────┘
```

The free heuristics gate the call; the model only runs for free-form queries with no literal keyword, and the free parser even interprets the model's answer.

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

## Project exercises

### Log heuristic-vs-LLM agreement to detect drift

- **Exercise ID:** B1.5 (adapted) — heuristic-before-LLM observability.
- **What to build:** in the query flow, run `parseIntent(q)` alongside `classifyIntent(q)` and record when they disagree, so you can measure the heuristic's mis-classification rate over real traffic.
- **Why it earns its place:** shows you understand heuristics drift silently and that the way to catch it is to measure agreement with the more capable resolver.
- **Files to touch:** `app/api/agent/route.ts` (compute both in the query branch near L211), a small log sink (e.g. extend the future `ai-call-log.ts` from → 06-token-economics.md).
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

## Interview defense

### What an interviewer is really asking

"How do you decide when to call the model?" tests whether you treat the LLM as a default or a last resort. The senior signal is naming the free checks that gate it and acknowledging the heuristic's drift risk — not pretending the substring match is flawless.

### Likely questions

**[mid] How does the system route a query without always paying for a model call?**

Two free checks first. The route branches on parameter presence (`q` vs `insightId`, `app/api/agent/route.ts` L210). Inside the query flow, `parseIntent` (`lib/agents/intent.ts` L6–L12) resolves any input containing a literal intent keyword for free. Only genuinely free-form queries reach `classifyIntent` (the haiku call).

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
- `app/api/agent/route.ts` L210 — parameter-presence routing before any model call.
- `lib/agents/intent.ts` L14 — haiku tier for the paid path (cheap, → 06-token-economics.md).
- Heuristic risk: confidently wrong on tricky phrasing; drifts as inputs evolve.

---

## See also

→ 06-token-economics.md · → 03-sampling-parameters.md · → 08-provider-abstraction.md · → 01-what-an-llm-is.md

---
