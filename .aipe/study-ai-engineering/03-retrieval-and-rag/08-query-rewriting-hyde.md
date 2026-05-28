# Query rewriting & HyDE (transform the question before you retrieve)

**Industry name(s):** query rewriting, query expansion, HyDE (Hypothetical Document Embeddings), query understanding
**Type:** Industry standard · Language-agnostic

> The user's raw question is rarely the best retrieval query; query rewriting reshapes it (expand, decompose, or — in HyDE — embed a *hypothetical answer* instead of the question) so it lands closer to the documents that hold the answer; blooming insights does query *understanding* (classify intent, translate to EQL) but not retrieval-query rewriting, so this is study material grounded in a real analog.

**See also:** → 01-embeddings.md · → 05-dense-vs-sparse.md · → 06-hybrid-retrieval-rrf.md · → ../04-agents-and-tool-use/04-tool-routing.md

---

## Why care

blooming insights already does the *first half* of query understanding. When a free-form `?q=` arrives, `classifyIntent` (`lib/agents/intent.ts` L17–L31) sends it to a cheap model to label it monitoring/diagnostic/recommendation, and then the agent translates the natural-language question into structured EQL and tool arguments. That translation — from "why did sales drop on mobile?" into `event = checkout_started AND device = mobile` — is query understanding: reshaping the human question into the form the retrieval engine actually consumes.

The question query rewriting answers is: when the user's literal words are a poor match for the documents, how do you transform the query so retrieval finds the right ones?

**The pivot: the user phrases questions in their vocabulary, but documents are written in theirs, and the vocabulary gap means the literal query embeds far from the answer that would satisfy it.** A user asks "why are people leaving without buying?"; the relevant past investigation is titled "cart abandonment on mobile checkout." Embedding the *question* lands near other questions; embedding a *hypothetical answer* (HyDE) lands near real answers, because answers look like answers. Rewriting closes the gap before retrieval, not after.

Before query rewriting:
- The raw question embeds near other questions, not near answer documents
- A multi-part question retrieves a muddled mix matching no single sub-question well
- Vocabulary mismatch (user words ≠ document words) silently lowers recall

After:
- The question is expanded/decomposed/transformed into a better retrieval query
- HyDE embeds a hypothetical answer, landing near real answers
- Each sub-question retrieves cleanly; recall rises before any reranking

It is the same move as normalizing a search box's raw input — trimming, expanding synonyms, splitting a compound query — before it hits the index, which is the kind of pre-processing the route already does with `.trim()` and `classifyIntent`.

---

## How it works

**Mental model.** Retrieval quality is bounded by the query you hand it: garbage query, garbage candidates, and no reranker can recover. Query rewriting is input pre-processing — the same discipline as sanitizing and normalizing a form field before you use it — applied to the retrieval query. You have three levers.

```
  raw question ──▶ [ rewrite ] ──▶ better retrieval query ──▶ retrieve
                      │
       ┌──────────────┼──────────────────┐
       ▼              ▼                   ▼
   EXPAND          DECOMPOSE            HyDE
   add synonyms    split compound       embed a hypothetical
   & context       into sub-queries      ANSWER, not the question
```

The body walks each lever and the codebase's existing query-understanding analog.

---

### Expansion: add the words the document uses

The raw query may lack the document's vocabulary. Expansion adds synonyms, related terms, or context so the query overlaps the document's wording (helps sparse retrieval directly; helps dense by pulling the embedding toward the topic).

```
  raw:      "people leaving without buying"
  expanded: "people leaving without buying; cart abandonment;
             checkout drop-off; failed conversion; abandoned purchase"
                     │
                     └──▶ now overlaps documents that say "cart abandonment"
```

A cheap model (the same tier as `classifyIntent`'s haiku) generates the expansion. Expansion trades precision for recall — too many added terms can pull in noise.

### Decomposition: split a compound question

A multi-part question retrieves badly because no single document matches all parts. Decomposition splits it into sub-queries, retrieves for each, and merges (often with RRF, `06`).

```
  raw: "why did mobile sales drop and what should we do?"
        │
        ├─▶ "why did mobile sales drop"        → retrieve diagnoses
        └─▶ "what to do about sales drops"     → retrieve recommendations
                     │
                     └──▶ merge results (each sub-query retrieved cleanly)
```

This mirrors what the route *already* does at the agent level: `classifyIntent` routes a question to diagnostic *or* recommendation, and a compound question is conceptually two intents. Decomposition is that split applied to retrieval queries.

### HyDE: embed a hypothetical answer, not the question

The sharpest trick. Questions and answers occupy different regions of embedding space — a question embeds near other questions. HyDE (Hypothetical Document Embeddings) asks a cheap model to *write a fake answer* to the question, then embeds *that* and retrieves with it. The fake answer is wrong in its specifics but right in its *shape and vocabulary*, so it lands near the real answer documents.

```
  question "why are users churning?"
       │
   model writes a HYPOTHETICAL answer:
   "Users churn when onboarding friction rises and the
    activation event fires less often after signup..."
       │
   embed the hypothetical answer (NOT the question)
       │
   retrieve ──▶ lands near REAL answer documents
                (answers look like answers)
```

The hypothetical answer is discarded after embedding; only its vector is used. HyDE costs one extra cheap generation per query and reliably lifts recall when question/answer vocabulary diverges.

### The codebase's query-understanding analog

blooming insights does query *understanding* — the sibling of query rewriting — without doing retrieval-query rewriting. `classifyIntent` (`lib/agents/intent.ts` L17–L31) is a query *classifier*; the agent then translates the question into EQL/tool args. That is reshaping the user's words into the engine's input form — exactly the spirit of query rewriting, applied to an exact analytics engine (EQL) rather than to embedding retrieval. The difference: EQL translation produces an *exact* query (the schema names are known), so there is no vocabulary-gap recall problem to close — the rewriting levers (expand/HyDE) matter for *fuzzy* retrieval, which the codebase does not yet do.

### The principle

Retrieval is only as good as the query handed to it, so transform the query to match the documents *before* retrieving — close the vocabulary gap with expansion, the compound-question problem with decomposition, and the question-vs-answer gap with HyDE's hypothetical answer. It is input normalization for the retrieval stage: the same reason you sanitize a form field before using it, applied to the question before it hits the index.

---

## Query rewriting & HyDE — diagram

This diagram spans the Service layer (the rewrite step before retrieval). A reader who sees only this should grasp that the raw question is transformed into a better retrieval query before the index is touched.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (would live in lib/mcp/retrieval.ts / lib/agents/)  │
│                                                                      │
│  CURRENT (query understanding, exact):                              │
│    raw q ──▶ .trim() (route) ──▶ classifyIntent (haiku) ──▶ intent  │
│           ──▶ agent translates to EQL/tool args (exact query)       │
│                                                                      │
│  PROPOSED (query rewriting, fuzzy retrieval):                       │
│    raw q                                                            │
│      ├─▶ EXPAND (synonyms/context)  ─┐                              │
│      ├─▶ DECOMPOSE (sub-queries)    ─┤─▶ better retrieval query(s)  │
│      └─▶ HyDE (hypothetical answer) ─┘        │                     │
│                                               ▼                     │
│                                        embed + retrieve (01/05/06)  │
└──────────────────────────────────────────────────────────────────────┘
```

The current path produces an exact EQL query; the proposed path reshapes a fuzzy question for embedding retrieval. Both are query understanding; only the second is retrieval-query rewriting.

---

## In this codebase

**Not yet implemented (retrieval-query rewriting).** blooming insights retrieves live via exact EQL — where the query is translated, not rewritten-for-recall — and has no embedding retrieval whose query would need expansion or HyDE.

The honest analog is real and present: blooming insights does *query understanding*, the sibling discipline. `classifyIntent` (`lib/agents/intent.ts` L17–L31) classifies the free-form `?q=` into an intent with a cheap haiku call (`max_tokens: 16`), preceded by the pure `parseIntent` substring heuristic (L6–L12). Then the agent translates the natural-language question into structured EQL and tool arguments — reshaping the user's words into the engine's consumable form. That translation is query-rewriting-adjacent: it transforms the question before retrieval. The difference is that EQL is *exact* (schema names are known), so there is no vocabulary-gap recall problem the expand/HyDE levers exist to solve. Those levers would live in a `lib/mcp/retrieval.ts` if fuzzy retrieval over past investigations is added. The `Project exercises` block below is the primary buildable target.

---

## Elaborate

### Where this pattern comes from

Query rewriting is older than RAG — query expansion (adding synonyms via thesauri or pseudo-relevance feedback) is a 1970s IR technique. The LLM era added two things: cheap generative rewriting (a small model expands or decomposes for pennies) and HyDE (Gao et al., 2022), which exploited the question-vs-answer embedding gap by generating a hypothetical document. Multi-query retrieval (generate several paraphrases, retrieve each, fuse) and step-back prompting (rewrite to a more general question first) are recent variants. All share one premise: spend a cheap generation to improve the query before paying for retrieval.

### The deeper principle

```
  problem                       rewriting lever        cost
  ──────────────────────────    ────────────────────   ──────────────
  vocabulary mismatch           expansion              1 cheap gen
  compound question             decomposition + fuse    1 gen + N retrievals
  question ≠ answer space       HyDE (hypothetical)     1 cheap gen
  ambiguous intent              classification          1 cheap gen (codebase HAS this)
```

Each lever spends a small, cheap model call to make the expensive retrieval more accurate — the same heuristic-then-LLM economy the codebase applies with `parseIntent` before `classifyIntent`. Query understanding (classify) and query rewriting (transform) are two faces of "fix the input before you act on it."

### Where this breaks down

1. **Expansion can hurt precision.** Adding too many synonyms pulls in loosely-related documents, lowering precision to raise recall. The expansion must be bounded and topical, not a thesaurus dump.

2. **HyDE can hallucinate the wrong shape.** If the cheap model writes a hypothetical answer about the wrong topic (misreads the question), its embedding lands near the wrong documents — a confident retrieval of irrelevant results. HyDE inherits the generator's mistakes.

3. **Rewriting adds latency and a failure point.** Every lever is an extra model call before retrieval. For exact queries (EQL) it is pure overhead — there is no recall gap to close, so rewriting would only add latency and risk mistranslation.

### What to explore next

- **Tool routing** (`../04-agents-and-tool-use/04-tool-routing.md`): `classifyIntent` is the query-understanding the codebase already ships.
- **Hybrid retrieval** (`06-hybrid-retrieval-rrf.md`): decomposed sub-queries are typically fused with RRF.
- **HyDE and multi-query retrieval:** the generative-rewriting techniques to evaluate when fuzzy retrieval exists.

### Honest security note

The free-form `?q=` is only `.trim()`'d (route) and passed straight to the model as `userPrompt` (`lib/agents/query.ts`), with no prompt-injection sanitization. Query rewriting is *not* input sanitization — a HyDE generator fed a malicious query inherits the injection. Rewriting improves recall; it does not harden the input. (See the production-serving security file for the injection treatment.)

---

## Tradeoffs

### Query rewriting (expand/decompose/HyDE) vs. raw query vs. classify-only (current)

| Dimension | Rewriting (rewrite then retrieve) | Raw query | Classify + EQL (current) |
|---|---|---|---|
| Closes vocabulary gap | Yes | No | N/A (exact query) |
| Handles compound questions | Yes (decompose) | No | Routes to one intent |
| Cost | +1 cheap gen per lever | Zero | +1 cheap gen (classify) |
| Latency | Higher (pre-retrieval gen) | Lowest | Low (16-token classify) |
| Right for fuzzy retrieval | Yes | No | N/A |
| Right for exact EQL | Overhead | N/A | Yes |

**What we gave up (by not having it).** Nothing today — EQL is exact, so there is no vocabulary-gap recall problem for rewriting to solve. The latent value appears only with fuzzy retrieval over free text (past investigations), where a user's question phrased in their words would embed far from an old investigation phrased in different words, and HyDE/expansion would recover the recall.

**What the alternative would have cost.** Adding query rewriting to the EQL path would be pure overhead and risk: an extra generation per query for no recall gain (the query is already exact), plus a new failure mode (a rewrite that mistranslates the schema). Rewriting belongs to fuzzy retrieval, not exact querying.

**The breakpoint.** Classify-and-translate-to-EQL is correct while retrieval is exact. Query rewriting (especially HyDE) earns its place the moment fuzzy retrieval over free text exists *and* user vocabulary diverges from document vocabulary — measured as a recall gap between raw-query and rewritten-query retrieval on real questions.

---

## Tech reference (industry pairing)

### query classification / understanding

- **Codebase uses:** `classifyIntent` (`lib/agents/intent.ts` L17–L31) — haiku, 16-token one-word intent; `parseIntent` (L6–L12) substring heuristic first.
- **Why it's here:** route the free-form `?q=` to the right agent and translate it to EQL — the present query-understanding.
- **Leading today:** small/cheap LLM classifiers lead query intent routing (2026).
- **Why it leads:** a 16-token classification is fast and pennies; far cheaper than running the wrong full agent.
- **Runner-up:** embedding-based intent matching (nearest exemplar) — no generation, but needs an embedder.

### query rewriting / expansion

- **Codebase uses:** nothing — EQL translation is exact, not recall-oriented rewriting.
- **Why it's here (absent):** exact queries have no vocabulary-gap recall problem.
- **Leading today:** LLM-generated query expansion and multi-query retrieval lead RAG query rewriting (2026).
- **Why it leads:** a cheap generation closes the user-vs-document vocabulary gap before retrieval.
- **Runner-up:** classic pseudo-relevance feedback — expand from top retrieved terms, no LLM needed.

### HyDE (Hypothetical Document Embeddings)

- **Codebase uses:** nothing.
- **Why it's here (absent):** no embedding retrieval whose query would benefit.
- **Leading today:** HyDE is a standard recall-boost when question/answer vocabulary diverges (2026).
- **Why it leads:** embedding a hypothetical answer lands near real answers, which questions do not.
- **Runner-up:** step-back prompting — rewrite to a broader question to retrieve foundational context first.

---

## Project exercises

### Add HyDE-based retrieval for past-investigation search

- **Exercise ID:** B2B.5 (adapted) — the primary buildable target.
- **What to build:** for the fuzzy "find similar past investigations" query, generate a hypothetical answer with a cheap model (haiku tier, like `classifyIntent`), embed *that* instead of the raw question, and retrieve. Compare recall against embedding the raw question.
- **Why it earns its place:** demonstrates you understand the question-vs-answer embedding gap and the cheap-generation-improves-retrieval economy — and that you apply it to fuzzy retrieval, not exact EQL.
- **Files to touch:** new `lib/mcp/retrieval.ts` (`hydeSearch`), `lib/agents/intent.ts` (reuse the haiku-tier model), `lib/mcp/embeddings.ts`, new `test/mcp/retrieval.test.ts`.
- **Done when:** a question phrased in user vocabulary retrieves a past investigation phrased differently that the raw-question embedding missed, with a measured recall improvement.
- **Estimated effort:** 1–2 days

### Add query decomposition for compound questions, fused with RRF

- **Exercise ID:** C2.8 (adapted) — decomposition.
- **What to build:** detect a compound `?q=` ("why did X drop and what should we do?"), split it into sub-queries with a cheap model, retrieve each over the investigation corpus, and fuse with RRF (`06`). Mirror the existing intent-routing split at the retrieval-query level.
- **Why it earns its place:** shows you handle multi-part questions by decompose-retrieve-fuse rather than one muddled retrieval, connecting query rewriting to fusion.
- **Files to touch:** `lib/mcp/retrieval.ts` (`decomposeAndRetrieve`), `lib/agents/intent.ts` (the split prompt), `lib/mcp/retrieval.ts` (`rrfFuse` from `06`), `test/mcp/retrieval.test.ts`.
- **Done when:** a two-part question retrieves clean candidates for each part and fuses them, outperforming a single retrieval of the raw compound query.
- **Estimated effort:** 1–2 days

---

## Summary

The user's literal question is rarely the best retrieval query: expansion closes the vocabulary gap, decomposition splits compound questions, and HyDE embeds a *hypothetical answer* so the query lands near real answer documents instead of near other questions. blooming insights does the sibling discipline — query *understanding*: `classifyIntent` labels the free-form question and the agent translates it into exact EQL — but not retrieval-query rewriting, because EQL is exact and has no vocabulary-gap recall problem. The rewriting levers earn their place only with fuzzy retrieval over free text, where HyDE and expansion measurably lift recall.

**Key points:**
- Retrieval quality is capped by the query handed to it — fix the input before retrieving.
- HyDE embeds a hypothetical answer because answers, not questions, look like answer documents.
- Decomposition mirrors the codebase's intent split, applied to retrieval queries and fused with RRF.
- The codebase does query understanding (classify + translate to EQL); EQL is exact, so no rewriting is needed.
- Query rewriting is not input sanitization — a HyDE generator inherits any prompt injection.

---

## Interview defense

### What an interviewer is really asking

"How do you improve retrieval when the user's words don't match the documents?" tests whether you fix the *query* before reaching for a better retriever. The senior signal is naming expansion/decomposition/HyDE, explaining the question-vs-answer embedding gap, and distinguishing query *understanding* (classify/translate, which the codebase does) from retrieval-query *rewriting* (which it does not, because EQL is exact).

### Likely questions

**[mid] What is HyDE and why does it help?**

HyDE generates a hypothetical *answer* to the question and embeds that instead of the question. Questions embed near other questions; answers embed near real answer documents. So the hypothetical-answer vector lands closer to the documents that actually answer the query, raising recall. The fake answer is discarded after embedding.

```
embed(question) → near other questions
embed(hypothetical answer) → near real answers ✓
```

**[senior] When is query rewriting pure overhead?**

When the query is already exact. blooming insights translates `?q=` into EQL with known schema names — there is no vocabulary gap to close, so expansion or HyDE would add a generation, latency, and a mistranslation risk for zero recall gain. Rewriting belongs to fuzzy embedding retrieval, not exact structured querying.

```
exact EQL query → rewriting = overhead
fuzzy embedding query → rewriting closes the recall gap
```

**[arch] How does decomposition relate to what the codebase already does?**

`classifyIntent` already splits a question into one intent (diagnostic/recommendation). A compound question is conceptually two intents; decomposition is that split at the *retrieval-query* level — break "why did X drop and what to do" into two sub-queries, retrieve each, fuse with RRF. Same "split the input" instinct, applied to retrieval.

```
classifyIntent: question → one intent
decomposition: question → sub-queries → retrieve each → RRF fuse
```

### The question candidates always dodge

**"Doesn't rewriting the query risk changing what the user asked?"** Yes — and it is the real cost. Expansion can pull in off-topic synonyms; HyDE can hallucinate the wrong topic and confidently retrieve irrelevant documents; decomposition can split a question wrong. Every lever inherits the cheap generator's mistakes. Naming this — that rewriting trades a recall gain for a mistranslation risk — is the senior signal, not blind enthusiasm for HyDE.

### One-line anchors

- `lib/agents/intent.ts` L17–L31 — `classifyIntent`: the query understanding the codebase ships (classify, not rewrite).
- `lib/agents/intent.ts` L6–L12 — `parseIntent`: substring heuristic before the cheap classifier.
- HyDE embeds a hypothetical *answer*; questions embed near questions, answers near answers.
- EQL is exact — no vocabulary gap, so retrieval-query rewriting is overhead.
- Rewriting is not sanitization — it inherits any prompt injection in the raw query.

---

## Validate

### Level 1 — Reconstruct

From memory, list the three query-rewriting levers (expand, decompose, HyDE) and state what each fixes. Explain why HyDE embeds an answer rather than the question.

### Level 2 — Explain

Out loud: why is query understanding (classify + translate to EQL) different from retrieval-query rewriting? Why is rewriting overhead for an exact query?

### Level 3 — Apply

Scenario: a fuzzy "find similar past work" feature retrieves poorly because users and old investigations use different words. Open `lib/agents/intent.ts` L17–L31 (`classifyIntent`, the cheap-model query understanding to reuse) and imagine the embedding retriever from `01`/`05`. Explain where HyDE would sit, which model tier it would use, and how you would measure the recall gain.

### Level 4 — Defend

A colleague wants to add HyDE to the EQL analytics path "to improve every query." Argue why it is overhead and risk for exact queries (no vocabulary gap, extra latency, mistranslation), and confine rewriting to fuzzy free-text retrieval. Then defend the codebase's existing classify-and-translate as the *correct* query understanding for exact analytics.

### Quick check — code reference test

What query-understanding does blooming insights do today, and why is retrieval-query rewriting (HyDE/expansion) not needed for it? (Answer: `classifyIntent` (`lib/agents/intent.ts` L17–L31) classifies the free-form `?q=` and the agent translates it into exact EQL; because EQL uses known schema names there is no user-vs-document vocabulary gap, so the expand/HyDE recall levers have nothing to fix.)
