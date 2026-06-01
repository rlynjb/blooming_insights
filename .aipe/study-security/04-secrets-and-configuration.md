# Secrets and configuration

**Industry name(s):** secret management, environment configuration, twelve-factor config, secret rotation, key derivation
**Type:** Industry standard · Language-agnostic

> Two real secrets live in this codebase: `ANTHROPIC_API_KEY` (the inference cost firewall) and `AUTH_SECRET` (the AES-256-GCM key for the `bi_auth` cookie). Both are env-var-only, both are documented in `.env.example`, and neither leaks into client bundles (no `NEXT_PUBLIC_` prefix). The genuine weaknesses: (1) the dev-only `.auth-cache.json` holds OAuth tokens in **plaintext on disk** (gitignored, but recoverable from a stolen laptop), (2) `AUTH_SECRET` has no graceful rotation path — rotating it invalidates every live session, (3) error responses on the streaming routes include stack traces (`e.stack` on `/api/mcp/call` L19 and `/api/mcp/tools` L20) which leak file paths, and (4) there's no enforcement that `AUTH_SECRET` is actually strong — any non-empty string is accepted.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Secrets in this app live in env vars (loaded by Next from `.env.local` in dev and from Vercel project settings in prod), in the dev-only `.auth-cache.json` (tokens at rest), and at runtime in the encrypted `bi_auth` cookie (tokens in transit/storage). Nothing else holds a secret. The threat model: an attacker who can read the env doesn't need to break crypto; an attacker who can read disk in dev gets cleartext tokens; an attacker who steals a `bi_auth` cookie *plus* `AUTH_SECRET` can decrypt it offline.

```
  Zoom out — where every secret lives

  ┌─ Repo (committed) ─────────────────────────────────┐
  │  .env.example       ← keys named, values blank     │
  │  .gitignore         ← .env*, .auth-cache.json      │
  │  NO real secrets in any committed file             │
  └─────────────────────────────────────────────────────┘

  ┌─ Dev box (uncommitted) ────────────────────────────┐
  │  .env.local         ← real ANTHROPIC_API_KEY       │
  │  .env.prod          ← (mirror of prod values)      │
  │  .auth-cache.json   ← PLAINTEXT OAuth tokens ★     │  ← we are here
  └─────────────────────────────────────────────────────┘

  ┌─ Production runtime (Vercel) ──────────────────────┐
  │  process.env.AUTH_SECRET       ← injected by Vercel│
  │  process.env.ANTHROPIC_API_KEY ← injected by Vercel│
  │  bi_auth cookie (browser)      ← AES-256-GCM       │
  └─────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question for each secret: *where does it live, who can read it, and what happens when it leaks?* This file walks every secret, names the protection it has and the protection it doesn't, and lists the operational gaps (rotation, audit, key strength enforcement) that a production deployment would need to close.

---

## Structure pass

**Layers.** Three altitudes of secret storage. **Repo** — anything committed to git, including `.env.example` and `.gitignore`. **Dev box** — `.env.local`, `.env.prod`, `.auth-cache.json`; uncommitted but at rest on the developer's machine. **Production runtime** — `process.env` injected by the host (Vercel), `bi_auth` cookie at the browser, no on-disk persistence (serverless FS is read-only).

**Axis: trust.** Hold one question constant: *who can read this layer, and what's the blast radius if they do?* Repo: anyone with repo read access. Dev box: anyone with developer-machine access (the developer themselves, anyone with file system access if compromised). Production: anyone with Vercel project access (rare), or anyone who can steal a browser cookie (more common).

**Seams.** Two load-bearing seams. **Seam 1 (repo → dev box)** is what `.gitignore` enforces — `*.env*` and `.auth-cache.json` never cross. **Seam 2 (dev box → production)** is the deploy boundary — env values are injected by Vercel, never copied from a local file. The cosmetic seam is between in-memory and on-disk in dev — both are on the same machine, so the trust level is the same.

```
  Structure pass — secret storage

  ┌─ 1. LAYERS ───────────────────────────────────────┐
  │  repo (committed)                                   │
  │  dev box (uncommitted, on local disk)               │
  │  production runtime (env + cookie)                  │
  └────────────────────────┬──────────────────────────┘
                           │  hold the trust question
  ┌─ 2. AXIS ─────────────▼───────────────────────────┐
  │  trust: who can read each layer, blast radius?     │
  └────────────────────────┬──────────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼───────────────────────────┐
  │  repo → dev box        .gitignore enforced         │
  │  dev box → production  Vercel env injection        │
  │  in-mem ↔ on-disk     same trust (dev only)        │
  └────────────────────────┬──────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped. Next we walk each secret and each storage layer.

---

## How it works

### Move 1 — the mental model

Secrets are values that grant capability. The discipline is "store them at the layer where the capability is exercised, never higher." A secret in the client bundle is wrong because the client doesn't *need* the capability; only the server does. A secret in the repo is wrong because the repo is read by everyone with code access; only the runtime needs the capability. A secret in plaintext on disk is wrong when there's a reasonable encrypted alternative — except in dev, where the threat model is "the developer's own machine, which they own."

```
  The discipline — where to store a secret

   capability holder            storage tier               example
   ─────                        ─────                      ─────
   server runtime only          env var (host-injected)    ANTHROPIC_API_KEY
                                                            AUTH_SECRET
   server runtime, persistent   encrypted at rest           bi_auth cookie
   user-side (oauth flow)       httpOnly + Secure cookie    bi_session
   never on client              n/a                          n/a (none in this app)
```

### Move 2 — walk each secret and each layer

#### Secret A — `ANTHROPIC_API_KEY`

The Anthropic API key. Used by `/api/agent`, `/api/briefing`, and `classifyIntent`. Without it the agent routes return 500 with the explicit message `'ANTHROPIC_API_KEY is not set'`.

```
  ANTHROPIC_API_KEY — what holds it

  ┌─ at rest (dev) ──────────────────────────────────┐
  │  .env.local       (gitignored via .env*)         │
  │  .env.prod        (gitignored; appears to be a   │
  │                    local mirror of prod values)  │
  └──────────────────────────────────────────────────┘

  ┌─ at rest (prod) ─────────────────────────────────┐
  │  Vercel project env vars (encrypted by Vercel,   │
  │  injected into the runtime as process.env)       │
  └──────────────────────────────────────────────────┘

  ┌─ at runtime ─────────────────────────────────────┐
  │  process.env.ANTHROPIC_API_KEY (server only)     │
  │  passed to: new Anthropic({ apiKey: ... })       │
  │  NEVER leaves the server process                 │
  └──────────────────────────────────────────────────┘
```

**Protection in place:**
- Gitignored via `.env*` pattern (`.gitignore` L29).
- Server-only — never exposed via `NEXT_PUBLIC_*` env var.
- Not logged anywhere (no `console.log(process.env.ANTHROPIC_API_KEY)`).
- Vercel encrypts env vars at rest in their dashboard.

**Risk:** the `.env.local` and `.env.prod` files on the dev box are plaintext. A stolen laptop = both keys exposed. The cost of leak: Anthropic billing fraud until the key is rotated. Mitigation: revoke the key in the Anthropic console, generate a new one, update Vercel. The app doesn't break — just the leaked key stops working.

**Notable absence:** there's no `.env*` check at app startup that warns "your `.env.local` is world-readable" or similar. Just standard filesystem perms.

#### Secret B — `AUTH_SECRET`

The high-entropy string that derives the AES-256 key for the `bi_auth` cookie via SHA-256. Required in production only.

```
  AUTH_SECRET — flow

  process.env.AUTH_SECRET (string, any length)
        │
        │  aesKey()  ── SHA-256 → 32 bytes
        ▼
  256-bit AES key
        │
        │  createCipheriv('aes-256-gcm', key, iv)
        ▼
  encrypt bi_auth cookie payload
```

**Protection in place:**
- Required in production (throws if unset — `lib/mcp/auth.ts` L52–L58).
- Documented in `.env.example` with `openssl rand -base64 32` generation hint.
- Server-only; never sent to client.
- Used only via `aesKey()` (one function); never logged.

**Risks:**

1. **No strength enforcement.** `aesKey` accepts *any non-empty string* and SHA-256s it. `AUTH_SECRET=password` would produce a deterministic 32-byte AES key. The hash hides the weakness from the AES layer, but the underlying entropy is still ~10 bits. The `.env.example` says "strong random secret (>= 32 chars)" — but there's no runtime check.

2. **No rotation path.** Rotating `AUTH_SECRET` invalidates *every* `bi_auth` cookie (all decrypt to `{}`). Every active user is forced to reauth on their next request. There's no key-version field in the encrypted payload that would let the server try both old and new keys during a transition. Mitigation: rotation is a planned-downtime event, not a routine operation.

3. **Single-key crypto.** All sessions share one key. Stealing `AUTH_SECRET` + the database of `bi_auth` cookie values would let the attacker decrypt all of them offline. Mitigation: cookies aren't logged or stored server-side; only the live cookie value matters.

4. **No HMAC separation.** GCM authenticates the ciphertext (the auth tag does double duty), so this is fine — but it's worth noting that the same key is used for the IV-prefixed encrypt step. GCM with random IVs (which this code does via `randomBytes(12)`) is correct.

#### Secret C — OAuth tokens in dev (`.auth-cache.json`)

In development, the auth store is a plaintext JSON file at `process.cwd() + '/.auth-cache.json'`. This is the explicit choice — Next's dev server hot-reloads, which would wipe a `Map`, and disk is the simplest backend that survives. The file contains the per-session OAuth tokens (`access_token`, `refresh_token`, expiry) directly.

```
  .auth-cache.json — what's in it (dev only)

  {
    "<bi_session uuid>": {
      "clientInformation": { "client_id": "..." },
      "codeVerifier": "...",
      "tokens": {
        "access_token": "eyJ...",         ← PLAINTEXT
        "refresh_token": "...",            ← PLAINTEXT
        "expires_in": 3600,
        "token_type": "Bearer"
      },
      "state": "..."
    },
    "<other session>": { ... }
  }
```

**Protection in place:**
- Gitignored explicitly (`.gitignore` L33–L34, with a `# dev-only oauth token cache (plaintext tokens — never commit)` comment).
- Dev-only — `PERSIST = NODE_ENV === 'development'` (`lib/mcp/auth.ts` L34).
- Comment block at L25–L33 spells out the threat model.

**Risks:**

1. **Stolen laptop = real Bloomreach tokens.** Anyone with file access to the dev machine reads the tokens directly. Mitigation: rotation via Bloomreach (revoke the token), and disk encryption on the dev machine (a personal responsibility, not enforced by this codebase).

2. **Backup leaks.** If the dev machine is backed up to an unencrypted location (a NAS, an old USB drive), the tokens go with it. Same mitigation.

3. **Cross-process read on shared machines.** On a multi-user dev box, another user with read access to the repo directory can read the file. Mitigation: standard Unix file perms (the file is created `644` by default which is world-readable on many systems).

The honest framing in the code (L33): *"the dev cache holds OAuth tokens in plaintext; it is local-only and gitignored."* This is accepted risk for the dev experience.

#### Secret D — OAuth tokens in production (`bi_auth` cookie)

In production, the same per-session state is in the AES-256-GCM-encrypted `bi_auth` cookie. Mechanics in `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md`.

```
  bi_auth — what protects it

  layer                       protection
  ─────                       ─────
  encryption                  AES-256-GCM, key derived from AUTH_SECRET
  integrity                   GCM auth tag (16 bytes); tamper → {} on decrypt
  cookie flags                httpOnly + Secure + SameSite=None
  lifetime                    10-day maxAge (lib/mcp/auth.ts L49)
  storage                     browser only; no server-side copy
```

**Risk:** the cookie value, while encrypted, is portable. Anyone who steals it can replay it for 10 days. The only revocation path is `POST /api/mcp/reset` (which deletes the cookie on the server's set-cookie response — but the attacker holding the original value still has it; the user *thinks* they've logged out but a stolen cookie still works until Bloomreach revokes the underlying token). The closer-to-correct revocation requires invalidating *the access token itself* at Bloomreach, which our reset route doesn't do.

#### Layer A — the repo (`.env.example`, `.gitignore`)

```
  .env.example contents (committed)
  ─────
  ANTHROPIC_API_KEY=              ← name only, no value
  BLOOMREACH_MCP_URL=https://loomi-mcp-alpha.bloomreach.com/mcp/
  NEXT_PUBLIC_APP_NAME="blooming insights"
  APP_ORIGIN=http://localhost:3000
  AUTH_SECRET=                    ← name only, no value
  # BLOOMREACH_PROJECT_ID=...     ← optional, commented out
```

`.env.example` is the template. No real secrets. The `NEXT_PUBLIC_APP_NAME` is the only `NEXT_PUBLIC_*` variable — that's intentional (it's the app's display name, used in the page title). No `NEXT_PUBLIC_ANTHROPIC_KEY` or similar — the audit confirms no API key prefixed `NEXT_PUBLIC_` exists.

`.gitignore` (L29–L34) blocks `.env*` (with `!.env.example` exception) and `.auth-cache.json` and `.investigation-cache.json`. Audit confirms `.env.local` and `.env.prod` are present on disk but not tracked (`.gitignore` excludes them).

**Risk:** git history. If a secret ever was committed and later deleted, it's still in git history. Audit didn't run `git log -p | grep -i 'AUTH_SECRET=\|sk-ant-'` to scan for accidental commits — that's a deployment-time check, not a structural one. Assume it hasn't happened until verified.

#### Layer B — error messages and logs

Errors caught in the streaming routes log to `console.error` with the full error (Vercel captures these in their dashboard). Errors returned to the client include the error message, and on `/api/mcp/call` and `/api/mcp/tools` they include the stack trace.

```
  Error response leakage

  /api/mcp/call route.ts L17–L20:
    return NextResponse.json(
      { error: e.message + '\n' + (e.stack ?? '') },  ← STACK TRACE IN RESPONSE
      { status: 500 }
    )

  /api/mcp/tools route.ts L18–L22: same pattern.

  /api/agent route.ts L161–L164: NO stack trace, just message.
  /api/briefing route.ts L167–L170: NO stack trace, just message.
  /api/agent route.ts L257–L259: NO stack trace, just message.
```

**Risk:** stack traces leak file paths, internal function names, and library versions. Severity: low (information disclosure, not a privilege escalation), but real. The streaming routes already use the safer pattern (message only); the two `/api/mcp/*` routes are inconsistent. Fix: remove `e.stack` from those two routes' responses.

### Move 3 — the principle

**A secret is well-managed when (a) the storage layer matches the trust level of the consumer, (b) the leak path is named and bounded, and (c) the rotation path exists.** This codebase nails (a) and partially (b), and is honest about not having (c) for `AUTH_SECRET`. The audit's finding isn't "you have insecure secrets" — it's "you have well-documented accepted-risk gaps that the next deployment maturity step has to address."

---

## Primary diagram

The full secret/config topology with every storage layer.

```
  Secrets and configuration — full topology

  ┌─ Committed to repo ──────────────────────────────────────────────┐
  │                                                                    │
  │  .env.example   ← TEMPLATE, no values                             │
  │  .gitignore     ← blocks .env*, .auth-cache.json                  │
  │                                                                    │
  │  NEXT_PUBLIC_APP_NAME    ← only "public" env var; just app title  │
  │                                                                    │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Dev box (uncommitted) ──────────────────────────────────────────┐
  │                                                                    │
  │  .env.local        ← ANTHROPIC_API_KEY=...                        │
  │                      BLOOMREACH_MCP_URL=...                       │
  │                      APP_ORIGIN=http://localhost:3000             │
  │                                                                    │
  │  .env.prod         ← (local mirror; gitignored)                   │
  │                                                                    │
  │  .auth-cache.json  ★ PLAINTEXT OAuth tokens (sessionId→tokens)    │
  │                                                                    │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Production runtime (Vercel) ────────────────────────────────────┐
  │                                                                    │
  │  process.env.ANTHROPIC_API_KEY       ← Vercel-injected            │
  │  process.env.AUTH_SECRET             ← Vercel-injected            │
  │  process.env.BLOOMREACH_MCP_URL      ← Vercel-injected            │
  │  process.env.APP_ORIGIN              ← Vercel-injected            │
  │  process.env.BLOOMREACH_PROJECT_ID   ← Vercel-injected (optional) │
  │                                                                    │
  │  bi_auth cookie at browser           ← AES-256-GCM(AUTH_SECRET)   │
  │  bi_session cookie at browser        ← random UUID                │
  │                                                                    │
  │  NO on-disk persistence (serverless FS is read-only)              │
  │                                                                    │
  └───────────────────────────────────────────────────────────────────┘
```

The diagram makes one finding visible: the dev `.auth-cache.json` is the only place real OAuth tokens sit unencrypted at rest. Everything else is either env-var-only (no encryption needed because the host protects it), encrypted (the prod cookie), or template (`.env.example` with empty values).

---

## Implementation in codebase

| Secret / config | File · Location | Lines | Where it lives |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `app/api/agent/route.ts` | L149–L151, L207 | env-only; route 500s if unset |
| `ANTHROPIC_API_KEY` | `app/api/briefing/route.ts` | L153–L155, L219 | same |
| `ANTHROPIC_API_KEY` | `lib/agents/intent.ts` (Anthropic instance) | passed to `classifyIntent` | n/a (constructor injection) |
| `AUTH_SECRET` | `lib/mcp/auth.ts` `aesKey` | L51–L60 | env-only; throws if unset (prod) |
| `AUTH_SECRET` usage | `lib/mcp/auth.ts` `encryptStore` / `decryptStore` | L62–L79 | only via `aesKey()` |
| `BLOOMREACH_MCP_URL` | `lib/mcp/connect.ts` `mcpUrl` | L25–L29 | env or hardcoded default; not a secret |
| `BLOOMREACH_PROJECT_ID` | `lib/mcp/schema.ts` `resolveProject` | L164–L167 | env; optional pin |
| `APP_ORIGIN` | `lib/mcp/connect.ts` `redirectUri` | L51 | env or `http://localhost:3000` |
| `NEXT_PUBLIC_APP_NAME` | `app/layout.tsx` | L10 | env or `"blooming insights"`; public |
| `NEXT_PUBLIC_DEMO_ONLY` | `app/page.tsx` | L121–L122 | env; controls demo-only mode |
| `.auth-cache.json` | `lib/mcp/auth.ts` `writeAll` / `readAll` | L113–L142 | plaintext JSON; dev only |
| `.auth-cache.json` gitignore | `.gitignore` | L33 | excluded with explicit comment |
| `.investigation-cache.json` | `lib/state/investigations.ts` | L7–L8, L33–L40 | dev only; no secrets |
| `bi_auth` cookie | `lib/mcp/auth.ts` `withAuthCookies` | L86–L104 | AES-256-GCM at the browser |
| Error msg leak (no stack) | `app/api/agent/route.ts` | L161–L164, L257–L259 | safe pattern |
| Error stack leak | `app/api/mcp/call/route.ts` | L17–L20 | `e.stack` in response ★ |
| Error stack leak | `app/api/mcp/tools/route.ts` | L18–L22 | `e.stack` in response ★ |
| Error stack leak | `app/api/mcp/capture/route.ts` | L54–L57 | `e.stack` in response (dev-only route) |
| Error stack leak | `app/api/mcp/tools/check/route.ts` | L21–L25 | `e.stack` in response ★ |

**Use case 1 — dev startup.** Developer runs `npm run dev`. Next reads `.env.local` (or `.env.development.local`) automatically. `process.env.ANTHROPIC_API_KEY` is now set. `process.env.AUTH_SECRET` may not be — `aesKey` only throws if it's read, which happens only inside `withAuthCookies`, which is `if (NODE_ENV !== 'production') return fn()` (auth.ts L87). So in dev, `AUTH_SECRET` is never touched.

**Use case 2 — production deploy.** Vercel injects all env vars from the project dashboard. `process.env.AUTH_SECRET` is set. First request triggers `withAuthCookies` → `aesKey()` → SHA-256 → AES key. If `AUTH_SECRET` is missing or empty, `aesKey` throws and the route's try/catch returns 500 with the message `'AUTH_SECRET is required in production…'`. The error is visible in Vercel logs.

**Use case 3 — secret rotation.** Operator rotates `AUTH_SECRET` in Vercel. Next deploy picks up the new value. Every existing `bi_auth` cookie decrypts to `{}` (`decryptStore` catch block, L76). Every active user gets a fresh OAuth flow on their next request. There's no key-version mechanism to honor old cookies during transition. This is a known one-way break.

---

## Elaborate

### Where this discipline comes from

**Twelve-factor app** (Heroku, 2011) codified "config in env vars" — strict separation of config from code, env vars as the lowest-common-denominator interface across hosts. Vercel inherits this directly.

**Key derivation functions** (PBKDF2, scrypt, Argon2, and the simpler HKDF/SHA-256 used here) come from the password-hashing tradition. Using SHA-256 on `AUTH_SECRET` to get an AES key is the **HKDF-extract** step done with a one-line hash — fine if `AUTH_SECRET` is itself high-entropy (32+ random bytes), wrong if it's a password-like string (where you'd want a memory-hard KDF like Argon2). The `.env.example` instructs `openssl rand -base64 32`, which produces 256 bits of entropy — exactly enough to feed SHA-256 without strengthening.

**AES-GCM with random IVs** (NIST SP 800-38D) is the modern authenticated-encryption choice. The 12-byte IV is the AES-GCM standard; the 16-byte auth tag is GCM's MAC. Two pitfalls: IV reuse (catastrophic for GCM — would let attackers recover the key) and storing the IV separately from the ciphertext (operational risk; the code stores them concatenated, which is correct). Both are handled.

### The deeper principle

**A secret's safety = entropy × isolation × rotation.** Entropy is what `aesKey` is silent on (no enforcement). Isolation is what gitignore + env-only handle. Rotation is what doesn't exist for `AUTH_SECRET`. A real production deployment improves one or more of these three dimensions; the audit names which ones the current state doesn't.

```
  Three dimensions of secret safety

  entropy      enforced?  no (any non-empty string accepted)
  isolation    enforced?  yes (env-only, gitignore, no NEXT_PUBLIC_)
  rotation     enforced?  no (rotation invalidates all sessions)
```

### Where it breaks down in this codebase

1. **Plaintext OAuth tokens in `.auth-cache.json`.** Dev-only, gitignored, well-commented — but the file is on the developer's disk in cleartext. The mitigation is "encrypt your dev disk" (operational).

2. **No `AUTH_SECRET` strength enforcement.** A minimum-length or entropy check at startup would catch `AUTH_SECRET=hunter2`. Trivial to add; not present.

3. **No `AUTH_SECRET` rotation.** A key-version byte prefix in the encrypted payload, plus a `AUTH_SECRET` + `AUTH_SECRET_OLD` env-var pair, would let rotations be graceful. Not present.

4. **Error response stack traces.** Four routes return `e.stack` in JSON. Information disclosure. One-line fix per route (remove `\n${e.stack ?? ''}` from the error message construction).

5. **No log scrubbing for tokens.** `console.error('[agent] error:', e)` includes the full error object. If a Bloomreach 401 includes an `invalid_token` error body that *echoes the token*, that token lands in Vercel logs. The code at `lib/mcp/transport.ts` captures non-OK HTTP bodies into an `HttpErrorHolder` and includes them in thrown errors — those errors get logged. The audit can't verify what Bloomreach echoes in 401 bodies without testing live, but the mitigation if needed is a token-redaction filter at the log layer.

### What to read next

- File [05-data-exposure-and-privacy.md](./05-data-exposure-and-privacy.md) — what else leaks via error responses (overlaps with point 4 above).
- File [06-dependencies-and-supply-chain.md](./06-dependencies-and-supply-chain.md) — the third-party trust layer (what dependencies could exfiltrate `process.env`).
- `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md` — the AES-256-GCM mechanics in depth.

---

## Interview defense

**What they are really asking:** can you say where every secret in your app lives, what protects it, and what the leak path is?

---

**[mid] — Walk me through every secret in this app.**

Two real secrets. `ANTHROPIC_API_KEY` — the inference cost firewall. Lives in `.env.local` on dev boxes, in Vercel env vars in prod. Never reaches the client (no `NEXT_PUBLIC_*` prefix). Used only server-side to construct the Anthropic SDK client.

`AUTH_SECRET` — the AES-256-GCM master key for the `bi_auth` cookie. Required in prod only (`aesKey` throws if unset). Used by one function (`aesKey()`) which SHA-256s it to a 32-byte AES key. Never logged.

Plus the things that *carry* secrets at runtime: the `bi_auth` cookie at the browser (encrypted, httpOnly, 10-day maxAge), and the dev-only `.auth-cache.json` file which holds plaintext OAuth tokens — gitignored, with an explicit comment in the code that it's plaintext and local-only.

```
  ANTHROPIC_API_KEY  env-only, server-only, gitignored
  AUTH_SECRET        env-only, server-only, gitignored
  bi_auth            AES-256-GCM, httpOnly, browser-only
  .auth-cache.json   plaintext, dev-only, gitignored
```

---

**[senior] — What happens if AUTH_SECRET is set to something weak like "password"?**

`aesKey()` SHA-256s it and returns a 32-byte buffer. AES-256-GCM accepts that buffer as a key — it doesn't care about the entropy of what was hashed. So *encryption* works fine. The problem is decryption-by-attacker.

If an attacker steals a `bi_auth` cookie value and knows (or guesses) that `AUTH_SECRET=password`, they hash it, decrypt the cookie offline, and recover the OAuth tokens. The threat model assumed `AUTH_SECRET` has 256 bits of entropy (the `.env.example` says `openssl rand -base64 32`). With a guessable secret, that assumption breaks.

The fix is a startup check in `aesKey`: require `secret.length >= 32` or run an entropy estimate. Two lines. It's not in the code today. The `.env.example` documents the requirement but the code doesn't enforce it.

```
  one-line fix:
   if (secret.length < 32) throw new Error('AUTH_SECRET must be at least 32 chars')
```

---

**[arch] — How would you rotate AUTH_SECRET without logging every user out?**

Today, you can't. Rotating `AUTH_SECRET` invalidates every `bi_auth` cookie — `decryptStore` returns `{}` (the catch block at L76 swallows the GCM auth-tag failure), the route sees no auth state, the user gets redirected to OAuth. Every active session breaks at once.

To rotate gracefully you'd need: (1) a key-version byte prefix in the encrypted payload, so the decrypt path can pick which key to try; (2) two env vars, `AUTH_SECRET` (current) and `AUTH_SECRET_OLD` (previous); (3) `encryptStore` always writes with the current key; (4) `decryptStore` tries current first, then old; (5) a transition window where both keys are honored; (6) after the window, set `AUTH_SECRET_OLD=""` to revoke the old key.

That's a real change, not a one-liner. It's also accepted-risk territory for a single-tenant demo app — if you only have one user (you), forcing a reauth on rotation is fine. For a real production deployment with concurrent users, the rotation path would be a blocker.

---

**The dodge — "where do real OAuth tokens go in production?"**

They never touch disk. The full per-session state — `clientInformation`, `codeVerifier`, `tokens`, `state` — is AES-256-GCM-encrypted under `AUTH_SECRET` and lives entirely in the `bi_auth` cookie at the browser. The serverless function has no persistence; every request seeds an in-memory ALS-scoped store from the cookie at the start and flushes it back at the end (`withAuthCookies` in `lib/mcp/auth.ts` L86–L104).

The dev story is different — dev uses a plaintext `.auth-cache.json` file because the dev server hot-reloads (a Map would wipe mid-flow). The code's comment block is explicit about this being a deliberate choice: prod encrypts; dev accepts the plaintext for ergonomic reasons.

---

**One-line anchors:**
- Two real secrets: `ANTHROPIC_API_KEY` (cost firewall) and `AUTH_SECRET` (cookie crypto key).
- `AUTH_SECRET` has no rotation path; rotating logs everyone out.
- No `NEXT_PUBLIC_*` secrets — nothing leaks to the client bundle.
- Dev plaintext tokens in `.auth-cache.json` are accepted risk; gitignored; commented in code.
- Four routes leak `e.stack` in error responses (information disclosure, low severity, one-line fix per route).

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, name every env var the app reads (hint: `ANTHROPIC_API_KEY`, `AUTH_SECRET`, `BLOOMREACH_MCP_URL`, `BLOOMREACH_PROJECT_ID`, `APP_ORIGIN`, `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_DEMO_ONLY`, `NODE_ENV`). For each, say whether it's a secret. Then check against the table.

### Level 2 — Explain
Why does `aesKey` SHA-256 `AUTH_SECRET` instead of using it directly? What invariant does the hash enforce, and what threat does it NOT defend against? Check `lib/mcp/auth.ts` L51–L60.

### Level 3 — Apply
A new feature lands: per-user encrypted notes stored in a new cookie. Walk through how you'd encrypt them: do you reuse `AUTH_SECRET`, derive a new key per user, or generate a fresh per-cookie key? What's the rotation story for the new cookie? Reference the patterns in `auth.ts`.

### Level 4 — Defend
A teammate proposes deleting the `.auth-cache.json` file and using an in-memory `Map` in dev too, "to match prod." Defend or refute. (Hint: read the comment block at `lib/mcp/auth.ts` L25–L33 first.)

### Quick check
- Where is `AUTH_SECRET` first read at runtime? → `lib/mcp/auth.ts` `aesKey` L51–L60, called by `encryptStore`/`decryptStore`, called only inside `withAuthCookies`, which is no-op in dev.
- Where do plaintext OAuth tokens land on disk in dev? → `.auth-cache.json` at `process.cwd()`, gitignored.
- Which routes leak stack traces in their error responses? → `/api/mcp/call`, `/api/mcp/tools`, `/api/mcp/tools/check`, `/api/mcp/capture`.
- Which env var is `NEXT_PUBLIC_*` and why is that safe? → `NEXT_PUBLIC_APP_NAME` — just the page title; not a secret.

---

## See also

→ [00-overview.md](./00-overview.md) · [02-authentication-and-authorization.md](./02-authentication-and-authorization.md) · [05-data-exposure-and-privacy.md](./05-data-exposure-and-privacy.md) · [06-dependencies-and-supply-chain.md](./06-dependencies-and-supply-chain.md) · [08-security-red-flags-audit.md](./08-security-red-flags-audit.md)

Cross-reference: `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md` — the AES-256-GCM cookie crypto in depth.
