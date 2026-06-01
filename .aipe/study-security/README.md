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

## The eight files

| # | File | What it audits |
|---|---|---|
| 00 | [Overview — trust boundary map](./00-overview.md) | Where every trust boundary lives in this repo, and which file owns it |
| 01 | [Trust boundaries and attack surface](./01-trust-boundaries-and-attack-surface.md) | Every place untrusted input crosses into trusted code |
| 02 | [Authentication and authorization](./02-authentication-and-authorization.md) | Who you are (OAuth/PKCE/DCR) vs what you're allowed to do (per-resource gates) |
| 03 | [Input validation and injection](./03-input-validation-and-injection.md) | SQL / command / path / SSRF / XSS / prompt — where input hits a sink unsanitized |
| 04 | [Secrets and configuration](./04-secrets-and-configuration.md) | Keys, tokens, connection strings — repo, history, client bundle, env hygiene |
| 05 | [Data exposure and privacy](./05-data-exposure-and-privacy.md) | Over-fetching, PII in logs/errors, verbose error messages, leaky responses |
| 06 | [Dependencies and supply chain](./06-dependencies-and-supply-chain.md) | Lockfile, CVEs, postinstall risk, update posture, transitive bloat |
| 07 | [LLM and agent security](./07-llm-and-agent-security.md) | Tool-scope discipline, output handling, exfiltration via tool calls |
| 08 | [Security red-flags audit](./08-security-red-flags-audit.md) | Consolidated checklist — fires / doesn't / N/A, with severity and one-line fix |

---

## How to read this guide

If you want the **shortest path to "is this safe to ship":** read 00 (the map) and 08 (the checklist). That gives you the trust topology and every fire/no-fire call against this specific repo.

If you want the **per-boundary deep dive:** read 01 through 07 in order. Each file picks one boundary, traces the trust axis across it, and shows the real file + line where the decision lives.

If you're **here to defend it in an interview or a security review:** every concept file ends with an Interview defense block (the questions a senior reviewer will actually ask) and a Validate block (four levels: reconstruct → explain → apply → defend).

---

## Cross-references

Two existing files in this codebase already cover slices of the security surface from a different angle:

- `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md` — the canonical OAuth/PKCE/DCR + encrypted cookie treatment, from the architecture angle. File 02 (authentication-and-authorization) references it instead of re-deriving the mechanics.
- `.aipe/study-ai-engineering/06-production-serving/03-prompt-injection.md` — the prompt-injection treatment from the LLM angle (what the attack shape is, why structural defenses work). File 03 and 07 reference it instead of duplicating; the trust-boundary framing here is complementary.

---

## What this audit does NOT cover

- **Threat modeling at scale.** No DDoS analysis, no abuse cost modeling, no distributed-systems trust (this isn't a multi-tenant service).
- **Compliance.** No GDPR/CCPA/SOC2 paperwork. The audit is technical — if the code touches PII unsafely, it's flagged here, but the policy frame is not.
- **Penetration testing.** No exploit code. The spec is explicit: name the weakness, name the fix, never write the attack.
- **Bloomreach IdP internals.** The MCP server's auth, rate-limits, and data handling are out of scope — we audit the trust boundary *toward* it, not its insides.
