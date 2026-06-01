# Dependencies and supply chain

**Industry name(s):** supply-chain security, dependency posture, lockfile integrity, SCA (software composition analysis), CVE management
**Type:** Industry standard · Language-agnostic

> The dependency surface is **small and modern**: 6 runtime deps + 8 dev deps, all on current major versions (Next 16.2.6, React 19.2.4, MCP SDK 1.29.0, Anthropic SDK 0.99.0). `package-lock.json` is committed, so installs are reproducible. None of the direct dependencies declare a `postinstall` script. There's no SBOM, no `npm audit` automation, no Dependabot/Renovate config visible in the repo, and no pinned versions (every dep uses `^` ranges) — so on a fresh `npm install` you can drift onto a newer minor/patch than was tested. The realistic supply-chain risk in this codebase is "a future minor of Next/React/an SDK introduces a regression" (handled by the lockfile) plus the standard "any of ~400 transitive packages could be compromised" baseline that every JS app shares.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Supply-chain risk in JS apps comes from three places: (1) the *direct* dependencies you declared and trust, (2) the *transitive* dependencies they brought along (the ones you didn't directly choose), and (3) the *install-time* code execution surface (postinstall scripts, native binary downloads, package-tarball tampering). The lockfile pins exact versions and integrity hashes for everything, so once you've installed a known-good tree, you're safe from npm-side tampering on subsequent installs.

```
  Zoom out — where supply-chain risk enters

  ┌─ Direct deps (package.json) ───────────────────┐
  │  6 runtime + 8 dev = 14 chosen packages         │
  └────────────────────────┬───────────────────────┘
                           │  each pulls in transitives
  ┌─ Transitive deps ─────▼────────────────────────┐
  │  ~400+ packages (typical for a Next app)       │
  │  every one runs in the same Node process        │
  └────────────────────────┬───────────────────────┘
                           │  install + at-runtime
  ┌─ Surfaces ────────────▼────────────────────────┐  ← we are here
  │  postinstall scripts                            │
  │  native binary downloads                        │
  │  CVE-vulnerable transitives                     │
  │  malicious version updates (typosquats etc.)   │
  └────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question for each surface: *what does the codebase do to constrain it, and what's accepted-risk?* This file walks the direct deps (small list), the transitive surface (large; relies on lockfile + npm registry security), and the install-time risks (none of the direct deps run install scripts).

---

## Structure pass

**Layers.** Three altitudes. The **direct dep manifest** (`package.json` — 14 packages I chose). The **resolved tree** (`package-lock.json` — every transitive locked to an exact version + integrity hash). The **install-time execution** (any `preinstall` / `install` / `postinstall` hook that runs during `npm install`).

**Axis: trust.** Hold one question constant: *which sources do I trust, with what discipline, and what enforces the discipline?* I trust the npm registry to serve the packages I asked for (enforced by HTTPS + the registry's signing). I trust the lockfile to reproduce the same tree (enforced by `npm ci`'s checksum verification). I trust the direct deps' maintainers (enforced by... nothing automated). I trust the transitives implicitly (enforced by *the direct deps' maintainers' choices*).

**Seams.** Two load-bearing seams. **Seam 1 (package.json → package-lock.json)** is where the floating `^` ranges resolve to exact versions. The lockfile pins; without it, every `npm install` could resolve differently. **Seam 2 (npm install → executed code)** is where install hooks run with full filesystem access in your repo. Most packages have none; the few that do are the supply-chain attention area.

```
  Structure pass — supply-chain surfaces

  ┌─ 1. LAYERS ───────────────────────────────────────┐
  │  package.json (direct, with ^ ranges)              │
  │  package-lock.json (resolved tree, exact)          │
  │  install-time scripts (postinstall etc.)           │
  └────────────────────────┬──────────────────────────┘
                           │  hold the trust question
  ┌─ 2. AXIS ─────────────▼───────────────────────────┐
  │  trust: which sources, with what discipline?       │
  └────────────────────────┬──────────────────────────┘
                           │  trace, find what's enforced
  ┌─ 3. SEAMS ────────────▼───────────────────────────┐
  │  manifest → lockfile      ranges → exact + hashes  │
  │      enforced by npm; lockfile committed           │
  │  install → execution      hooks run in your repo   │
  │      no direct dep declares one (audit confirmed)  │
  └────────────────────────┬──────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped. Next we walk each layer.

---

## How it works

### Move 1 — the mental model

A supply-chain attack lands by getting *your* `npm install` to execute *their* code. The attacker's playbook has three moves: typosquat (publish a package with a name close to a popular one and hope someone typos), version takeover (compromise a maintainer's npm account and ship a malicious version of a real package), or transitive injection (compromise a deeply-nested transitive that you don't even know is in your tree). The defenses are:

```
  Attacks vs defenses

  attack                 defense                       enforced?
  ─────                  ─────                         ─────
  typosquat              "I read the package name"     human; no automation here
  version takeover       lockfile + integrity hashes   yes (package-lock.json)
                         registry-level signing         yes (npm/Vercel)
  transitive injection   audit + restricted scopes     no automation in this repo
                         SBOM tracking                  none in this repo
  install-time exec      no postinstall in tree         confirmed for direct deps
```

### Move 2 — walk each layer

#### Layer A — the direct deps (`package.json`)

```
  package.json — full dep list

  runtime (dependencies):
    @anthropic-ai/sdk         ^0.99.0   ← LLM client
    @modelcontextprotocol/sdk ^1.29.0   ← MCP client, drives OAuth
    lucide-react              ^1.17.0   ← icon set
    next                      16.2.6    ← framework  (PINNED exact)
    react                     19.2.4    ← UI lib     (PINNED exact)
    react-dom                 19.2.4    ← UI lib     (PINNED exact)

  dev (devDependencies):
    @tailwindcss/postcss      ^4
    @types/node               ^20
    @types/react              ^19
    @types/react-dom          ^19
    eslint                    ^9
    eslint-config-next        16.2.6    ← PINNED exact
    tailwindcss               ^4
    typescript                ^5
    vitest                    ^4.1.7
```

**What's notable:**
- 14 direct packages total. Small list for a Next.js + AI app.
- 4 packages are pinned to exact versions (no `^`): `next`, `react`, `react-dom`, `eslint-config-next`. Everything else floats on `^`.
- No `lucide-react` actually used in any imports the audit examined — could be unused. (Not a security finding, but a `package.json` hygiene flag.)
- No `zod` / `valibot` / `joi` / `yup` — no schema validation library. This is consistent with the codebase using hand-rolled type guards (`lib/mcp/validate.ts`); it also means there's nothing in the dep tree for the audit to validate the input-validation choice against (file 03 covers the hand-rolled guards).

#### Layer B — the lockfile (`package-lock.json`)

`package-lock.json` is committed (8415 lines per `wc -l`). That's the load-bearing piece of supply-chain defense — it locks every transitive to an exact version with an integrity hash. `npm ci` (or `npm install` with the lockfile present) verifies each downloaded tarball against the hash. A registry compromise that replaces the tarball would fail the hash check and the install would abort.

```
  package-lock.json — the trust anchor

  ┌─ entry for @anthropic-ai/sdk@0.99.0 (paraphrased) ──┐
  │  "version": "0.99.0",                                │
  │  "resolved": "https://registry.npmjs.org/@anthropic-│
  │    ai/sdk/-/sdk-0.99.0.tgz",                         │
  │  "integrity": "sha512-...integrity hash...",         │
  │  "engines": { "node": ">=18" },                      │
  │  "dependencies": { ...exact versions... }            │
  └──────────────────────────────────────────────────────┘

  on `npm ci`:
    for each entry:
      download from resolved URL
      compute sha512
      compare to integrity field
      if mismatch → ABORT install
```

**What's protected:** registry-side tarball swap, mid-flight MITM (HTTPS handles this anyway), accidental version drift.

**What's NOT protected:** a maintainer pushing a new, malicious patch version to a dep that the lockfile then *gets updated to* (via `npm install` without `--lock-only` or via a teammate's `npm update`). The lockfile only enforces "if you ran `npm ci`, you get exactly what was last committed." It doesn't prevent the *next* `npm install` from upgrading within `^` ranges.

#### Layer C — install-time execution (postinstall etc.)

The audit checked the direct deps for `postinstall` / `preinstall` / `install` scripts and found none:

```
  postinstall surface — direct deps

  @anthropic-ai/sdk         no install hook
  @modelcontextprotocol/sdk no install hook
  next                      no install hook
  react                     no install hook
  react-dom                 no install hook
  lucide-react              no install hook
  vitest                    no install hook

  (audit grep -l '"postinstall"' across direct dep package.jsons — empty result)
```

Transitives may have install hooks (some native binary packages do — `esbuild`, `sharp`, `fsevents` on macOS), but those are well-known and load native code at install time. They're not a vector unless they themselves are compromised.

#### Layer D — CVE posture

**No `npm audit` automation visible in the repo.** No CI config (`.github/workflows/`) was checked for audit gates. No Snyk / Dependabot / Renovate config files at the root.

The audit didn't run `npm audit` itself to enumerate current advisories — that's a deployment-time check (and the output changes daily as new CVEs are published). The structural finding: there's no automated guardrail that fails CI when a known-vulnerable transitive lands.

Manual remediation cadence is implied (`npm audit` + `npm audit fix` on demand). For a single-developer demo app, this is acceptable; for a production deployment with multiple contributors, it's a process gap.

#### Layer E — registry trust

The default npm registry is `https://registry.npmjs.org`. The lockfile's `resolved` URLs point there. No private registry, no scoped registry (e.g., a corporate npm proxy). The trust assumption is "npm registry is correctly distributing packages and hashes" — which is the same assumption every other JS project makes. Mitigation against npm-side compromise is the lockfile + integrity hashes (Layer B).

### Move 3 — the principle

**The lockfile is the single most important supply-chain control in a JS project — and committing it is most of the defense.** Beyond that, the gains from automated audit gates, SBOM tracking, and proactive update cadence are real but linear; the lockfile is the step-change. This codebase commits the lockfile, so the baseline is solid; the missing automation is the next-mile improvement.

---

## Primary diagram

The full supply-chain topology with every surface.

```
  Supply-chain topology — blooming insights

  ┌─ Repo (committed) ───────────────────────────────────────────────┐
  │                                                                    │
  │  package.json           ← 14 direct deps, mostly ^ ranges         │
  │  package-lock.json      ← 8400+ lines, exact versions + integrity │
  │                                                                    │
  │  .gitignore: /node_modules                                        │
  │  no Dependabot/Renovate config                                    │
  │  no audit gate in CI (CI not enumerated by audit)                 │
  │                                                                    │
  └───────────────────────────┬───────────────────────────────────────┘
                              │  npm ci (CI) or npm install (dev)
                              ▼
  ┌─ Install-time ───────────────────────────────────────────────────┐
  │                                                                    │
  │  for each dep:                                                    │
  │    download tarball from registry.npmjs.org                       │
  │    verify integrity hash from package-lock.json                   │
  │    place in node_modules/                                         │
  │    run postinstall (if any)                                       │
  │                                                                    │
  │  direct deps with postinstall: NONE (audit confirmed)             │
  │                                                                    │
  └───────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
  ┌─ Runtime ────────────────────────────────────────────────────────┐
  │                                                                    │
  │  Node process imports from node_modules                           │
  │  ~400 transitive packages execute in the same V8 isolate          │
  │  any one of them has full process.env access                      │
  │                                                                    │
  │  ★ implicit trust in every transitive                             │
  │  ★ no per-module sandboxing (Node doesn't offer that)             │
  │                                                                    │
  └──────────────────────────────────────────────────────────────────┘
```

The diagram makes the residual risk visible: any transitive can read `process.env.ANTHROPIC_API_KEY` and exfiltrate it. Lockfile + integrity hashes mean you'll catch a *change* in transitive contents, but they don't reduce the size of the trusted surface.

---

## Implementation in codebase

| Layer | Artifact | Lines / file | What it does |
|---|---|---|---|
| A: manifest | `package.json` | 14 deps | Declares direct deps with `^` ranges (mostly) and 4 pinned |
| B: lockfile | `package-lock.json` | 8415 lines | Pins every transitive to exact version + sha512 |
| B: install verification | (npm built-in) | n/a | `npm ci` aborts on integrity mismatch |
| C: install hooks | (none on direct deps) | n/a | Audit confirmed no postinstall on `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `next`, `react`, `react-dom`, `lucide-react`, `vitest` |
| D: CVE automation | (none) | n/a | No Dependabot, Renovate, or CI audit gate visible |
| E: registry trust | `package-lock.json` `resolved` URLs | n/a | Defaults to `registry.npmjs.org` |
| Gitignore for `node_modules` | `.gitignore` | L4 | Standard exclusion |

**Use case 1 — fresh clone + install.** New developer runs `npm install`. npm reads `package-lock.json`, downloads each tarball, verifies integrity hashes, places in `node_modules`. The install is reproducible — same tree as every other developer who used the same lockfile.

**Use case 2 — minor version bump.** A `^` range matches a new minor (e.g., `@anthropic-ai/sdk` bumps from 0.99.0 to 0.100.0). A developer running `npm install` (not `ci`) gets the new version, the lockfile updates, the diff goes into PR review. If `npm audit` flagged a new CVE in the new version, the developer sees it; if not, the bump goes through.

**Use case 3 — a transitive gets compromised.** The npm registry serves a malicious version of (hypothetical) `acorn-walk@8.3.1` to anyone running `npm install` without a lockfile pin. Our developers running `npm ci` get the OLD version because the integrity hash in the lockfile doesn't match the new tarball — install aborts. Defense held. The same scenario without a lockfile (or with `npm install` updating it) would slip through.

---

## Elaborate

### Where this discipline comes from

**The event-stream incident (2018)** is the canonical npm supply-chain attack: a popular package was transferred to a new maintainer who quietly added a malicious payload targeting a specific downstream wallet app. The lockfile movement (and the addition of integrity fields in npm 5+) was a direct response.

**SLSA (Supply chain Levels for Software Artifacts)**, originally from Google (2021), formalizes a maturity ladder: SLSA 1 = scripted builds; SLSA 2 = hosted build, source/build provenance; SLSA 3 = isolated build, signed provenance; SLSA 4 = two-person review + hermetic builds. Most apps live at SLSA 1; the lockfile + npm registry gets you a partial SLSA 2.

**SBOM (Software Bill of Materials)** — formalized as CycloneDX (2017) and SPDX — is the artifact a security auditor needs to answer "are you affected by CVE-X?" without re-running your build. This codebase doesn't generate one; for a hackathon/demo app, that's accepted; for production it's the next-mile.

### The deeper principle

**Defense in depth applies to the supply chain too.** The lockfile is layer 1 (reproducibility). Integrity hashes are layer 2 (registry tampering). Audit automation is layer 3 (known CVEs). SBOM tracking is layer 4 (vulnerability response). Code review of every PR diff (including lockfile changes) is layer 5 (catching what automation missed). This codebase has layers 1 and 2; the others are deployment-maturity additions.

```
  Five layers of supply-chain defense — what this repo has

  layer 1: lockfile         ✓ committed
  layer 2: integrity hashes ✓ from npm
  layer 3: audit automation ✗ none
  layer 4: SBOM tracking    ✗ none
  layer 5: PR review of deps  unknown (single-dev repo)
```

### Where it breaks down in this codebase

1. **No audit automation.** A new CVE in a transitive lands silently. The first signal is a manual `npm audit` someone runs. Fix: a GitHub Actions workflow that runs `npm audit --audit-level=high` on every PR.

2. **`^` ranges on 10 of 14 deps.** A teammate (or a fresh clone with `npm install` instead of `npm ci`) drifts onto newer minor versions than the lockfile. The drift is bounded by semver (no major bumps), but a malicious patch from a compromised maintainer would land. Fix: use `npm ci` in CI; deliberate `npm install` only in `npm update`-style maintenance.

3. **No SBOM.** When a CVE breaks news ("are you affected by CVE-2026-XXXX in `<package>`?"), the answer requires `npm ls <package>` to enumerate the tree. Fix: `npm sbom` or a CycloneDX tool generates a snapshot per release.

4. **No private registry / scoped registry.** The default `registry.npmjs.org` is the implicit trust root. Mitigation: out of scope for a hackathon app; relevant for an enterprise that wants to whitelist allowed packages.

5. **Unused or near-unused deps add risk for no benefit.** `lucide-react` is in `dependencies` but the audit didn't find imports of it. If unused, every transitive it pulls in is dead weight + attack surface. Fix: confirm via `npx depcheck` and remove if unused.

### What to read next

- File [04-secrets-and-configuration.md](./04-secrets-and-configuration.md) — what an exfiltration via a malicious transitive could grab (the env vars).
- File [08-security-red-flags-audit.md](./08-security-red-flags-audit.md) — every supply-chain finding consolidated.

---

## Interview defense

**What they are really asking:** can you articulate the supply-chain risks of a JS app and name what this specific app does (and doesn't do) about them?

---

**[mid] — How does this app manage its dependencies?**

Fourteen direct deps, mostly on `^` ranges, four pinned exact (`next`, `react`, `react-dom`, `eslint-config-next`). `package-lock.json` is committed, so `npm ci` reproduces the exact tree every time. None of the direct deps run a `postinstall` script. The runtime deps are six: Anthropic SDK, MCP SDK, lucide-react, Next, React, React DOM. The MCP SDK is the load-bearing one — it's what drives the OAuth + PKCE + DCR flow.

What's *not* in place: no Dependabot or Renovate, no `npm audit` gate in CI, no SBOM generation. For a single-developer demo app, the manual cadence is acceptable; for a multi-contributor production deployment, the CI audit gate would be the first add.

```
  what's done           what's not
  ─────                 ─────
  lockfile committed    no Dependabot
  integrity hashes      no SBOM
  no direct postinstall no CI audit gate
```

---

**[senior] — What's the actual supply-chain risk for an app like this?**

Three realistic vectors. (1) A maintainer of one of the direct deps (or any transitive) ships a malicious version. The lockfile pins the *current* tree, so existing installs are safe; the *next* `npm install` is where it lands, unless the new version's integrity hash mismatches what's in the lockfile (it always will — different code, different hash — so `npm ci` would abort and `npm install` would update the lockfile and the PR would show the diff). (2) A typosquat — irrelevant if you only ever install from `package.json` and never type a package name directly. (3) A CVE in a transitive that's actively exploited — mitigated by upgrading via `npm audit fix`; not automated here.

The single highest-leverage move would be a CI step that runs `npm audit --audit-level=high` on every PR and fails the build on a new high-severity advisory. That converts "someone has to remember" into "the pipeline enforces."

---

**[arch] — If a malicious npm package landed in this tree, what could it actually do?**

Anything the Node process can do. Node modules run in the same V8 isolate with no per-module sandboxing. A malicious transitive imported by the app at runtime gets `process.env.ANTHROPIC_API_KEY`, `process.env.AUTH_SECRET`, the AES key, the OAuth tokens in memory — all of it. The damage budget is "everything the process can see."

What bounds it in this specific app: the package would need to be `require`'d or `import`'d into a code path that actually runs. Dev-only deps (Vitest, ESLint, Tailwind plugins) don't run in production, so a malicious build-time tool can poison the build output but can't exfiltrate runtime secrets directly. Runtime deps (Anthropic SDK, MCP SDK, Next, React) run in every request — a compromise there is full-fat.

The defense isn't sandboxing (Node doesn't support it); it's *reducing the size of the trusted surface*. Fewer deps + audited transitives + the lockfile. This app's small dep list is the structural defense.

---

**The dodge — "have you run `npm audit`?"**

Not as part of this audit. The output is a moving target — new advisories land daily as packages get re-scanned. The structural finding is "no audit gate in CI," which means whatever `npm audit` says today, there's no guarantee it'll be re-checked tomorrow. The fix is automation, not a snapshot.

A reasonable deployment workflow: `npm audit --audit-level=high` in CI (fail on high or critical), Dependabot or Renovate to open PRs on advisories, and a quarterly `npm outdated` review for non-security update hygiene.

---

**One-line anchors:**
- 14 direct deps, lockfile committed, no postinstall on any direct dep — the baseline is solid.
- No CI audit gate, no Dependabot, no SBOM — the next-mile improvements aren't in place.
- The MCP SDK is the load-bearing supply-chain trust — it drives the OAuth flow.
- A malicious transitive at runtime can exfiltrate every env secret; bound by dep-count discipline, not by sandboxing.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, list the 6 runtime deps. Then check against `package.json`.

### Level 2 — Explain
Why is committing `package-lock.json` more important than pinning versions in `package.json`? What does each one defend against?

### Level 3 — Apply
A CVE is announced in `acorn` (a tiny transitive used by many JS tools). Walk through how you'd determine if this app is affected, which command(s) you'd run, and what the remediation path is. Reference `package-lock.json` and `npm` commands you'd use.

### Level 4 — Defend
A teammate proposes removing `package-lock.json` from the repo "because it generates merge conflicts." Defend or refute. (Hint: trace what changes about reproducibility, integrity, and CI builds.)

### Quick check
- What's the lockfile filename? → `package-lock.json` (committed).
- Which direct deps are pinned exact (no `^`)? → `next`, `react`, `react-dom`, `eslint-config-next`.
- Do any direct deps run a `postinstall` script? → No (audit confirmed via grep).
- Is there an automated CVE check in this repo? → No (no Dependabot/Renovate/CI audit gate visible).

---

## See also

→ [00-overview.md](./00-overview.md) · [04-secrets-and-configuration.md](./04-secrets-and-configuration.md) · [08-security-red-flags-audit.md](./08-security-red-flags-audit.md)
