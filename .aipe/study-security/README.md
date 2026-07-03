# Security — trust axis of blooming insights

The only question: what can an attacker reach, and what happens when they do?

This guide traces that question across every boundary in the repo — where untrusted input enters, who's allowed past, what's hidden vs exposed, and what the dependencies drag in. Every finding cites a real file and line range. When a control is load-bearing enough to earn a deep walk, it gets a numbered pattern file.

---

## Reading order

Start at the top, stop when the map is enough.

```
  ┌─ Orient ────────────────────────────────────────────────┐
  │  00-overview.md    the trust map + the three highest    │
  │                    risks + a one-line verdict per lens  │
  └──────────────────────────────┬──────────────────────────┘
                                 │
  ┌─ Full audit ─────────────────▼──────────────────────────┐
  │  audit.md          8 lenses walked over the real repo   │
  │                    with file:line grounding             │
  └──────────────────────────────┬──────────────────────────┘
                                 │
  ┌─ Deep walks on load-bearing controls ────────────────────┐
  │  01-encrypted-cookie-auth-store.md                       │
  │  02-oauth-pkce-with-dcr.md                               │
  │  03-read-only-tool-allowlist.md                          │
  │  04-model-output-type-guards.md                          │
  │  05-budget-ceiling-defense.md                            │
  │  06-log-secret-redaction.md                              │
  └──────────────────────────────────────────────────────────┘
```

---

## The trust axis at a glance

Three trust boundaries in this repo. The Bloomreach loomi connect server is the only third party the agents reach; the Anthropic API is the model provider (fully server-side, key never touches the browser); the browser is where the analyst sits.

```
  Trace the trust axis across three hops

  ┌─ Browser (untrusted) ──────────────────────────┐
  │  React app, QueryBox, sessionStorage insights   │
  │  can send: any JSON in ?insight= / ?diagnosis=  │
  └──────────────────────┬─────────────────────────┘
                         │  hop 1: HTTP request
                         │  → sid cookie (httpOnly)
                         │  → bi_auth cookie (AES-256-GCM)
                         ▼
  ┌─ Next.js server (trusted core) ────────────────┐
  │  app/api/{briefing,agent,mcp/*}                 │
  │  ALS-scoped RequestStore, type-guarded output   │
  │  ★ every trust decision lives here ★            │
  └──────┬──────────────────────────┬───────────────┘
         │                          │
         │ hop 2a: HTTPS + Bearer  │ hop 2b: HTTPS + API key
         ▼                          ▼
  ┌─ Bloomreach MCP ──────┐   ┌─ Anthropic API ────┐
  │  OAuth 2.1 / PKCE      │   │  claude-sonnet-4-6  │
  │  data provider         │   │  model provider     │
  │  (semi-trusted)        │   │  (semi-trusted:     │
  │                        │   │   its output       │
  │                        │   │   is UNTRUSTED)    │
  └────────────────────────┘   └─────────────────────┘
```

**The one that carries the weight:** hop 2b's return direction. Anthropic is a trusted counterparty for the request but its response is untrusted input crossing back into your system. `parseAgentJson` + the `isAnomalyArray` / `isDiagnosis` / `isRecommendationArray` type guards in `lib/mcp/validate.ts` are the seam that keeps model output from flowing straight to the UI.

---

## Where to look for what

| Question | File |
|---|---|
| What are the highest risks right now? | `00-overview.md` |
| Does this repo do X? (any lens) | `audit.md` |
| How does the encrypted cookie actually work? | `01-encrypted-cookie-auth-store.md` |
| How does OAuth flow across the redirect? | `02-oauth-pkce-with-dcr.md` |
| Why can the client only call some tools? | `03-read-only-tool-allowlist.md` |
| Where is model output validated? | `04-model-output-type-guards.md` |
| What stops a runaway agent from burning $$? | `05-budget-ceiling-defense.md` |
| Where do we scrub tokens from logs? | `06-log-secret-redaction.md` |

---

## Cross-links to sibling guides

- **`study-system-design`** — architecture, request flow, streaming NDJSON contract. Non-security-shaped concerns about how the pieces fit together.
- **`study-data-modeling`** — the `Insight` / `Anomaly` / `Diagnosis` / `Recommendation` types. Security says who's allowed to read/write them; data modeling says what they look like.
- **`study-software-design`** — deep modules, layering, information hiding. Security is a lens *through* the design, not the design itself.
