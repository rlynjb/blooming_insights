# Study — Security

Security audit of blooming insights, traced along the **trust axis**: every input is hostile until proven otherwise, every boundary either enforces a trust decision or leaks one.

This is not a marketing document. The point of the audit is to name what the codebase gets right *and* what it doesn't — code-level findings, not aspirations. Where the repo is too small to exercise a concept honestly, it's said. Where a real gap exists, it's named with file and line, not softened.

```
  The only question:  what can an attacker reach, and what happens when they do?

  trace the trust axis across every boundary ─────────────
     where does untrusted input enter?      (the attack surface)
     who is allowed past this boundary?      (authn / authz)
     what's hidden, what's exposed?          (secrets / data)
     what do my dependencies let in?         (supply chain)
```

---

## Reading order

This guide uses the two-pass shape: one survey file (`audit.md`) and five pattern files. Read in this order:

| # | File | What it covers |
|---|---|---|
| — | [Overview — security in blooming insights](./00-overview.md) | One-page orientation: the trust topology + the file index |
| — | [audit.md](./audit.md) | Pass 1 — the 8-lens audit (trust boundaries, authn/authz, input validation, secrets, data exposure, deps, LLM/agent, red-flags) with top-3 ranked findings |
| 01 | [encrypted-cookie-oauth-state](./01-encrypted-cookie-oauth-state.md) | AES-256-GCM `bi_auth` cookie carrying full OAuth state across serverless requests |
| 02 | [als-scoped-request-store](./02-als-scoped-request-store.md) | `AsyncLocalStorage<RequestStore>` — the synchronization primitive behind `withAuthCookies` |
| 03 | [type-guard-trust-boundary](./03-type-guard-trust-boundary.md) | `parseAgentJson` + `isXxx` + `FALLBACK` — the load-bearing model-output gate |
| 04 | [read-only-tool-whitelist](./04-read-only-tool-whitelist.md) | Per-agent capability minimization in `lib/mcp/tools.ts` |
| 05 | [open-tool-surface-gap](./05-open-tool-surface-gap.md) | The H1 finding: `POST /api/mcp/call` accepts any tool name with no allowlist |

---

## How to use this guide

**Quickest read.** Open `audit.md`. The verdict-first paragraph + "Top 3 ranked findings" section gives you the headline in two screens.

**Per-boundary depth.** Each pattern file walks one mechanism from zoom-out to interview defense. Pick the one that matches the question you have.

**Defending it in an interview or review.** Every pattern file ends with an **Interview defense** block (the questions a senior reviewer will actually ask, with model answers + diagrams) and a **Validate** block (four levels: reconstruct → explain → apply → defend).

---

## Cross-references

Two existing files in this codebase already cover slices of the security surface from a different angle:

- `.aipe/study-system-design/02-oauth-boundary.md` — the canonical OAuth/PKCE/DCR + encrypted cookie treatment, from the architecture angle. `01-encrypted-cookie-oauth-state.md` references it instead of re-deriving the OAuth mechanics.
- `.aipe/study-ai-engineering/06-production-serving/03-prompt-injection.md` — the prompt-injection treatment from the LLM angle (what the attack shape is, why structural defenses work). Both `03-type-guard-trust-boundary.md` and `04-read-only-tool-whitelist.md` reference it instead of duplicating.

---

## What this audit does NOT cover

- **Threat modeling at scale.** No DDoS analysis, no abuse cost modeling, no distributed-systems trust (this isn't a multi-tenant service).
- **Compliance.** No GDPR/CCPA/SOC2 paperwork. The audit is technical — if the code touches PII unsafely, it's flagged here, but the policy frame is not.
- **Penetration testing.** No exploit code. The spec is explicit: name the weakness, name the fix, never write the attack.
- **Bloomreach IdP internals.** The MCP server's auth, rate-limits, and data handling are out of scope — we audit the trust boundary *toward* it, not its insides.
