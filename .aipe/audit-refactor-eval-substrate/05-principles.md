# Chapter 05 — Principles

The principles chapter walks SRP, DRY, Separation of Concerns, Dependency Inversion, Open/Closed, Liskov, Interface Segregation, Locality of Behaviour, Principle of Least Surprise, and Tell-Don't-Ask. The earlier chapters named techniques (Extract Function, Adapter, Circuit Breaker); this one names the principles those techniques serve. The lens is different: where Chapter 01 asked "is this function the right shape?", this chapter asks "which principle is this code honoring or violating, and does it matter here?"

The opinionated through-line: this codebase honors SRP, Locality of Behaviour, and Principle of Least Surprise well; it strains against Dependency Inversion at the route layer and Separation of Concerns in `app/page.tsx`; and its most interesting violation is **Tell-Don't-Ask** — applied beautifully by `McpClient`, violated subtly by every `res.usage` call site that asks and doesn't tell. The deepest principle in this book is the one nobody named in the existing audits.

## Map of the territory

- **DEEP — Single Responsibility (`app/page.tsx`).** Eight concerns in 817 LOC. Already audited deeply in `study-software-design/02-shallow-module-page-component.md`. This chapter ranks it as the second-most-consequential principle violation in the repo and explains why the cleanup is real but not the load-bearing one.
- **DEEP — Dependency Inversion (the route handler).** Inverts the lib-layer's DI discipline. Covered structurally in Chapter 02; recast here as the principle violation that gates the eval harness's ability to reach the route layer.
- **DEEP — Tell-Don't-Ask (the `res.usage` non-read).** The most interesting principle violation in the codebase and the one no other audit names by principle. The SDK *tells* you what each call cost; the call sites *ask* by returning the response and then silently discarding the `usage` field. The fix is the cost meter from Chapter 03 reframed as a principle correction.
- **BRIEF — DRY (the two `synthesize()` copies, the two `tryParseX` near-twins).** Already covered as Extract Function in Chapter 01; recast here under the principle. Verdict identical.
- **BRIEF — Separation of Concerns (NDJSON parsing inside React components / hooks).** Trivial; covered in Chapter 02 under Extract Module.
- **BRIEF — Locality of Behaviour.** This codebase honors LoB well by default. Worth naming because it sometimes conflicts with DRY (covered briefly).
- **MENTION** — Principle of Least Surprise. The codebase has one deliberate surprise — `useInvestigation` deliberately doesn't cancel its fetch on cleanup (`lib/hooks/useInvestigation.ts:31-36`). The surprise is documented in a six-line comment. Don't change it.
- **NOT FOUND — Liskov Substitution.** No inheritance hierarchy worth checking. The four agent classes are siblings, not a hierarchy.
- **NOT FOUND — Open/Closed.** Not a framework codebase. The right shape is "add a new agent class" (open via Strategy), not "extend an existing class" (closed via inheritance). The lib does this already.
- **NOT FOUND — Interface Segregation.** The `McpCaller` interface is already minimal (one method). No interface in the repo is bloated.

---

### Single Responsibility — app/page.tsx (DEEP)

**Where it's violated.** `app/page.tsx` is 817 LOC with one default export. The audit (`study-software-design/02-shallow-module-page-component.md`) enumerates the eight concerns held in one file: rendering, NDJSON stream parsing, reconnect policy, demo capture, mode toggling, coverage accumulation, trace accumulation, stepper-state derivation. 14 `useState` slots in one component. Interface ≈ implementation; nothing hidden.

**Why it matters here.** Cognitive load on the next contributor is the immediate cost (`study-software-design/audit.md` complexity-in-this-codebase section ranks this #1). The deeper cost is testability: this is the most-used UI surface in the app, and `vitest.config.ts` is `environment: 'node'` with no `@testing-library/react` — the component cannot be unit tested today, and the file's shape makes integration testing harder than it needs to be. **The 817-LOC component is the part of the codebase that is most opaque to evidence-of-correctness, and the eval harness from Chapter 02 will never reach it.** That's an SRP violation translated into the through-line: the file is so far from single-responsibility that no testing pattern can pull it back without an extraction first.

**Is it worth fixing?** Yes — but rank it as the second-priority extraction in the book, not the first. The audit's Top-3 finding #1 names three hook extractions (`useBriefingStream`, `useReconnectPolicy`, `useDemoCapture`) that collapse the file to ~120 LOC of layout + composition. Each extraction is mechanical (the seams are already in the file as logical blocks; the lift is moving each block into its own hook). The order: extract `useBriefingStream` first (largest concern, most concentrated, retires the NDJSON parser duplication shared with `useInvestigation` — see Chapter 02). Extract the other two in follow-up PRs. Don't lift all three in one diff; the merge surface is too large to review safely.

The reason this lands as DEEP and not load-bearing: the cleanup is real but it's not on the critical path of the eval through-line. The file is opaque, the extraction is straightforward, the test surface unlocks once `@testing-library/react` is added — but none of that depends on the eval harness, and the eval harness doesn't depend on it. Different axes. The extraction is the right move on the SRP axis; the eval harness is the right move on the quality axis; both are worth doing; this book ranks the eval harness first because its effects are wider.

**Which techniques would address it.** Extract Hook (`useBriefingStream`, `useReconnectPolicy`, `useDemoCapture`), Extract Module (the NDJSON parser shared with `useInvestigation` — see Chapter 02's BRIEF), Move Function (the stepper-state derivation that should live next to the stepper component). Cross-references: `study-software-design/02-shallow-module-page-component.md` (the deep walk on this exact file), `study-software-design/audit.md` Top-3 finding #1 (the fix shape).

---

### Dependency Inversion — the route handler (DEEP)

**Where it's violated.** `app/api/agent/route.ts:1-16` and `app/api/briefing/route.ts` (same shape). Both import `Anthropic`, `connectMcp`, and the agent classes at the module top — concrete dependencies, no DI. Below this seam, the lib layer is exemplary: `runAgentLoop` takes `{ anthropic, mcp, ... }` as an options bag; the agent classes take `(anthropic, mcp, schema, allTools)` in their constructor; `McpClient` takes `(transport, opts)`. **The lib honors DI; the route handler inverts that discipline.**

**Why it matters here.** Two costs, both load-bearing for the through-line:

1. **The eval harness from Chapter 02 cannot reach the route layer.** The harness will exercise `DiagnosticAgent.investigate` and `RecommendationAgent.propose` directly because those are the seams that take fakes. The route's intent dispatch, cache-replay shortcut, and step routing logic — the orchestration that lives in the GET handler — is outside the harness's reach. Until the route's orchestration is extracted into a pure function the way Chapter 02 prescribes, the harness scope is capped at "single agent in isolation," not "agent orchestrated by the route." Most production bugs in route-shaped code live in the orchestration, not in the components.

2. **The 169 unit tests don't cover the route, and they can't, until the seam is inverted.** Cross-ref `study-testing/audit.md` Top-3 finding #1.

**Is it worth fixing?** Yes. The Chapter 02 fix is the extraction of `runInvestigation(deps)` into `lib/agents/runInvestigation.ts`. The GET handler becomes a thin wrapper that wires deps and calls the extracted function. The seam inverts: the framework entry point becomes the place where concrete dependencies are constructed, and the orchestration becomes pure-function-shaped and testable. One afternoon, one new file, every route-layer concern becomes inject-fakeable.

This is the textbook Dependency Inversion fix. It's worth doing on its own merits AND it's the prerequisite for any eval that wants to reach the orchestration layer.

**Which techniques would address it.** Extract Function (`runInvestigation`), Move Function (the agent-orchestration body from `route.ts:200-251` into the new file), introduce a `RunInvestigationDeps` type that names the seam. Cross-reference: Chapter 02 DEEP section "Dependency Inversion."

---

### Tell-Don't-Ask — the res.usage non-read (DEEP)

**Where it's violated.** Every `await anthropic.messages.create(...)` site. The SDK *returns* an object with `{ content, usage, ... }`. The codebase asks for that object, reads `content`, and silently discards `usage`. Four call sites: `lib/agents/base.ts:102`, `lib/agents/diagnostic.ts:97`, `lib/agents/recommendation.ts:96`, `lib/agents/intent.ts:18`.

**Why it matters here.** This is the most interesting principle violation in the codebase, and it's the one no other audit has framed as a principle violation. The audits frame it as a perf finding ("no `res.usage` logging anywhere"); the catalog frames it as a Tell-Don't-Ask violation, which makes the fix's *shape* obvious in a way the perf framing doesn't.

The Tell-Don't-Ask reading: the SDK has data the codebase needs (cost per call). The codebase asks for the response and then forgets to use part of it. The fix isn't to "log it once per call site" (that's the perf-finding fix, which is correct and worth doing). The deeper fix is to install a *probe* — a callback on `runAgentLoop` that the loop calls every time the SDK *tells* it the cost — so the call sites stop being responsible for remembering to read the field. The loop tells the probe; the probe tells the consumer (console, NDJSON trace, observability backend). The data flows; nobody asks.

The reason this lands as DEEP and not BRIEF: this principle violation is the same shape as the eval gap. Both are "the data exists; the consumer doesn't." The eval harness violates the principle on the *quality* axis (the agent tells the user a `Diagnosis`; nobody asks whether it's right). The cost meter violates the principle on the *cost* axis (the SDK tells the codebase the usage; nobody asks for it). **Both are the same principle violation; both have the same fix shape (install the probe at the seam, let the data flow); both are gated on installing a missing observer.** Naming them together by principle is the contribution this chapter makes that no other audit makes.

**Is it worth fixing?** Yes. Five-line console.log at every site (the perf-finding fix). Then the callback refactor (the Chapter 03 Probe pattern fix). Then the NDJSON trace integration (the eval-harness consumer). Three lifts, each cheaper than the previous, all serving the same principle correction.

**Which techniques would address it.** Extract Variable (just read `res.usage` into a named local at each call site — minimum viable), Observer / Probe pattern (Chapter 03's DEEP section), eventual integration into the NDJSON event stream (`lib/mcp/events.ts:4-17`) so the eval harness can score cost alongside quality.

---

### DRY (with care) — the two synthesize() copies, the two tryParseX near-twins (BRIEF)

**Where it's violated.** Covered in Chapter 01 as Extract Function. Reframed under principle: DRY says don't repeat yourself; the two `synthesize()` methods are the same shape with different bodies; the two `tryParseX` are the same body with different validators. Both are clean DRY violations.

**Take.** The catalog says "DRY with care" because Locality of Behaviour sometimes beats it. Here, neither DRY violation is held up by LoB — both pieces of duplicated code live in different files (`diagnostic.ts` and `recommendation.ts`), so the locality argument is "the duplication is already non-local; deduping it puts it in one place where the next reader looks for it." Locality and DRY agree; lift the abstraction. **Verdict: see Chapter 01 verdicts. The Tell-Don't-Ask take above also folds in here — the deeper unification is "stop duplicating the recovery shape across agents; install one recovery seam on the loop."**

---

### Separation of Concerns — NDJSON parsing inside React components / hooks (BRIEF)

**Where it's violated.** The NDJSON parsing loop is written twice (`lib/hooks/useInvestigation.ts:184-208`, `app/page.tsx:450-456`). The parsing concern is wire-format-level; it doesn't belong inside a React hook OR a React component. Chapter 02 prescribed the lift (Extract Module: `parseNdjsonStream<T>(reader)` async generator into `lib/mcp/ndjson.ts`).

**Take.** Same fix, named under the principle. The wire format is the parser's responsibility; the hook's responsibility is state management; the component's responsibility is rendering. Three concerns, three files. Today two of the three live mixed inside the other two. **Verdict: lift the parser (see Chapter 02 BRIEF section).**

---

### Locality of Behaviour — honored by default (BRIEF)

**Where it's honored.** The 6-line comment above `minIntervalMs: 1100` in `lib/mcp/connect.ts:82-88` is the canonical example (cited in `study-software-design/audit.md`). The comment carries the constraint (Bloomreach 1 per N seconds), the math (1100 not 10000), the related logic location (`McpClient` retry parsing), the consequence of changing it (route budget blown). The code below is one literal; the comment IS the design. **The behavior of changing `minIntervalMs` is local to the file where it's set, because the comment makes the dependency chain visible without forcing the reader to navigate.** Same pattern across `lib/mcp/auth.ts:21-34` (the three-backend selection), the `LIVE-VERIFICATION` block at the top of `connect.ts`, the step-split rationale in `app/api/agent/route.ts:24-28`.

**Take.** The principle this codebase honors most consistently is LoB, and the load-bearing instrument is the comment. The audits already praise this; naming it under the principle makes the reason explicit. The discipline lesson: when DRY and LoB conflict, this codebase has consistently chosen LoB plus a comment, and that's the right call most of the time. The cases where it doesn't (the two `synthesize()`, the two `tryParseX`) are the cases where the duplication is already non-local (different files) — at which point LoB stops protecting the duplication and DRY wins. **Verdict: don't refactor; recognize the discipline and protect it as you do the SRP cleanups (don't accidentally break a load-bearing comment when extracting a hook).**

---

### Principle of Least Surprise — one deliberate surprise, documented (MENTION)

**Where the surprise lives.** `lib/hooks/useInvestigation.ts:31-36`. The hook deliberately does NOT cancel its fetch on effect unmount. The six-line comment explains why (React StrictMode mount-clean-remount aborted the stream and emptied the logs; the started-guard prevents the double-fetch; the in-flight run completes safely because `setState` after unmount is a no-op).

**Take.** This is the right shape of "deliberate surprise" — visible in code, documented in a comment that names the failure mode (StrictMode double-mount), names the alternative considered (cleanup-cancel), and names why the alternative was rejected (broke the trace). The comment is load-bearing. Don't change the behavior; don't remove the comment; if you ever do touch this code, read the comment first and rewrite it if you choose differently. **Verdict: leave it.**

---

## Chapter close — the principle this codebase honors by default and the one it strains against

The principle this codebase honors by default is **Locality of Behaviour, expressed through load-bearing comments.** The discipline is visible everywhere: `connect.ts:82-88`, `auth.ts:21-34`, `agent/route.ts:24-28`, `useInvestigation.ts:31-36`, the LIVE-VERIFICATION block at the top of `connect.ts`. Each comment makes its file's behavior local — the reader doesn't have to navigate elsewhere to understand the dependency, the rationale, or the failure mode the code is preventing. This is the rarest discipline in single-developer codebases and it's the strongest pattern in the repo's reading experience.

The principle this codebase strains against most is **Tell-Don't-Ask, on the observability axis.** The SDK tells the codebase what each call cost; the call sites ask for the response and silently discard the cost field. The agent loop tells the consumer that the loop ran; the consumer asks for the result but doesn't ask "was the result good?" The eval substrate IS BUILT (events.ts, investigations.ts, validate.ts, the scripted-Anthropic harness, the McpCaller adapter) — and it's a substrate explicitly shaped to *tell* the consumer about agent behavior. The harness that *consumes* what the substrate tells isn't built. **The codebase has built every piece of a Tell-Don't-Ask architecture on the quality axis except the consumer side.** That's the same observation Chapter 02 made about module boundaries, Chapter 03 made about the Observer/Probe pattern, and the recon (`.aipe/audits/recon-2026-06-02.md`) made about the cap rule on the L0-L3 ladder. Four chapters, four framings, one finding.

The deeper observation, viewing the principles as a whole: **this codebase has senior-shaped discipline on correctness, clarity, and module design, and underweight discipline on the observability primitives that let the work be measured.** The fix is not to retrofit a different architecture. The fix is one additive directory (`evals/`), one additive callback on `runAgentLoop` (the cost probe), one extracted pure function (`runInvestigation`), and one session-keyed Map (`SessionStore`). Each of these is a principle correction; each is also a structural addition; each is also a pattern application; each is also a composition lift. The same four files, every chapter, every framing. That's the book.
