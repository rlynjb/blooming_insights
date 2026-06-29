# Secret redaction

**Pattern-based redaction at the log boundary** (Language-agnostic primitive).

## Zoom out — where this concept lives

This sits between the in-process error / response path and the log sink (Vercel function logs). The redactor rewrites token-shaped substrings before they reach `console.error` or get attached to thrown error envelopes.

```
  Zoom out — redaction on the way out

  ┌─ Next.js routes (trusted) ───────────────────────────┐
  │                                                       │
  │  thrown McpToolError (cause chain)                    │
  │             │                                          │
  │             ▼                                          │
  │       formatError(e)        ← walks .cause chain       │
  │             │                                          │
  │             ▼                                          │
  │       ★ redactSecrets(text) ★ ◄────── we are here     │
  │             │                                          │
  │             ▼                                          │
  │  console.error(...)                                    │
  └─────────────────────────┬─────────────────────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │  Vercel logs │
                    └──────────────┘
```

The principle: every secret that leaves the process boundary as text is one search-query away from being logged forever. The redactor catches them at the door.

## Structure pass

**Axes:** trust (logs are persistent + searchable; tokens in logs are credential leaks), failure (a missing redaction is invisible — the logs look fine until someone runs the right grep).

**Layers:** error origin → formatError (walks cause chain) → redactSecrets (regex substitution) → log sink.

**Seam:** the load-bearing seam is the *single call site* — every route's `console.error` runs `redactSecrets(formatError(e))`. Centralizing makes redaction reviewable; scattering would leave a hole the first time someone forgot.

## How it works

### Move 1 — the mental model

Pattern-based redaction is **"find every shape that *could* be a secret and replace it with a placeholder"**. It's pessimistic — it assumes any string matching the pattern IS a secret. The pattern set is the policy; missing a pattern means missing the secrets it would have caught.

```
  Pattern shape — match the secret shape, redact

  before: 'Bearer eyJhbGc...token...' or '"access_token":"ya29..."'
  after:  '[redacted]'                  or '"access_token":"[redacted]"'
                                             ↑ key kept so envelope shape readable
```

### Move 2 — the step-by-step walkthrough

#### The pattern set (`TOKEN_PATTERNS`)

Five regexes — one per token shape this codebase actually emits:

```ts
// lib/mcp/transport.ts:55-61
const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  /"access_token"\s*:\s*"[^"]+"/g,
  /"refresh_token"\s*:\s*"[^"]+"/g,
  /"id_token"\s*:\s*"[^"]+"/g,
  /"code_verifier"\s*:\s*"[^"]+"/g,
];
```

**Why these five:**
- `Bearer <token>` — the Authorization header attached to every MCP call. Some SDK failure paths attach the original request envelope to `err.cause`; without redaction the header text rides into the log.
- `"access_token"` / `"refresh_token"` / `"id_token"` — the three OAuth token-response fields. If the IdP returns a non-2xx response whose body is JSON, `makeCapturingFetch` (below) clones the body into the error holder; without redaction, a token-bearing error body would log raw.
- `"code_verifier"` — the PKCE secret. Logged only if a serialization bug stuffs the cookie store into an error message; defense in depth.

**What breaks if a pattern is missing:** the redactor passes the matching text through unchanged. A new token type (e.g. an API key, a JWT in a custom header) would need a new pattern. The set is fail-open by design — bad patterns don't break anything, missing patterns leak silently.

#### `redactSecrets`

```ts
// lib/mcp/transport.ts:66-76
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (match) => {
      if (match.startsWith('Bearer')) return '[redacted]';
      const key = match.match(/"([^"]+)"\s*:/)?.[1];
      return key ? `"${key}":"[redacted]"` : '[redacted]';
    });
  }
  return out;
}
```

Two redaction shapes:
- **Bearer matches** → collapse to bare `[redacted]`.
- **JSON-field matches** → keep the key (`"access_token":"[redacted]"`) so the surrounding envelope stays readable.

The shape-preservation is deliberate. A flat `[redacted]` everywhere makes the envelope harder to read in an incident; keeping the key (`"access_token"`) shows *what kind* of secret was there without showing the secret.

#### `formatError` — the cause-chain walk

`console.error(e)` formats `e.cause` chains via Node's `util.inspect`. Plain `String(e)` does NOT. So if you `String(e)` and then redact, a token nested inside `e.cause.cause` survives the redaction:

```ts
// lib/mcp/transport.ts:82-97
export function formatError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < 5) {
    if (cur instanceof Error) {
      parts.push(cur.stack ?? cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      cur = null;
    }
    depth++;
  }
  return parts.join('\n  caused by: ');
}
```

`formatError` walks the cause chain (cap 5) and assembles one string. That string is then handed to `redactSecrets`. The two-step is the chokepoint: every log line that wants to be safe goes through both.

**What breaks if `formatError` is skipped:** a token in `e.cause.cause` survives the redactor because `String(e)` only stringifies the outer error. The cap-5 walk is what unwraps every level so the regex pass sees every byte.

#### `makeCapturingFetch` — redact at storage time

The SDK doesn't expose non-2xx response bodies. To attach the real server error to thrown `McpToolError` instances, the transport wraps `fetch` with a capturing version. The body is redacted before being stored:

```ts
// lib/mcp/transport.ts:103-118
export function makeCapturingFetch(holder: HttpErrorHolder): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    if (!res.ok) {
      try {
        holder.last = {
          status: res.status,
          body: redactSecrets((await res.clone().text()).slice(0, MAX_BODY)),
        };
      } catch {
        /* body unreadable / already consumed — leave the holder as-is */
      }
    }
    return res;
  };
}
```

**Two protections at storage:**
- `slice(0, MAX_BODY)` — caps at 2000 bytes. Bounds memory + log volume.
- `redactSecrets(...)` — redacts the body before it's even stored in the holder. So a downstream consumer that doesn't know about redaction can't accidentally log raw token text.

This is **redact-on-write**, not redact-on-log. The data is already safe by the time it lives in `holder.last`.

#### Call sites — every route

Every route's catch path runs the pair:

```ts
// app/api/agent/route.ts:312
console.error('[agent] error:', redactSecrets(formatError(e)));

// app/api/briefing/route.ts:298
console.error('[briefing] error:', redactSecrets(formatError(e)));

// app/api/mcp/call/route.ts:37
console.error('[mcp-call] error:', redactSecrets(formatError(e)));
```

The pattern is consistent — `[route-tag] error: redactSecrets(formatError(e))`. The route tag makes Vercel-log filtering easy; the redact-format pair is the safety contract.

**What breaks if one route forgets:** a single token-bearing error logs raw. Searchable forever in Vercel. The right defense is a lint rule or a wrapper helper (`logError(tag, e)`); today it's manual discipline at every catch site.

### Move 3 — the principle

**Redact where the data is captured, not where it's logged.** `makeCapturingFetch` redacts before storage; `formatError + redactSecrets` redacts before `console.error`. Both points are doors the data passes through; both have a guard. The deeper principle: **secrets in logs are the easiest-to-make hardest-to-undo mistake.** Cloud log retention is forever; rotation of the leaked credential is the only recovery. Pessimistic pattern matching at every door is the policy that lets the rest of the code stop worrying.

## Primary diagram

```
  Secret-redaction call graph — two protected doors

  ┌─ MCP fetch (in transport) ──────────────────────┐
  │                                                  │
  │  fetch(url, init) ──► res                        │
  │           │                                      │
  │   !res.ok │                                      │
  │           ▼                                      │
  │      slice(0, 2000)                              │
  │           ▼                                      │
  │      redactSecrets(...)   ◄── DOOR 1 (storage)   │
  │           ▼                                      │
  │      holder.last = {status, body}                │
  └──────────────────────────────────────────────────┘

  ┌─ Route catch path ──────────────────────────────┐
  │                                                  │
  │  catch (e) {                                     │
  │     formatError(e)                                │
  │        ├─ walks .cause chain (cap 5)              │
  │        ├─ each level: stack ?? message            │
  │        └─ join('\n  caused by: ')                 │
  │           ▼                                       │
  │      redactSecrets(...)  ◄── DOOR 2 (log)        │
  │           ▼                                       │
  │      console.error('[route] error:', ...)         │
  │  }                                                │
  └──────────────────────────────────────────────────┘
                       │
                       ▼
                ┌──────────────┐
                │ Vercel logs  │
                └──────────────┘
```

## Elaborate

Pattern-based redaction is the **simple end of secret-handling** — sufficient for known token shapes, insufficient for things it can't pattern-match. The richer alternative is **structured logging with explicit field tagging** (e.g. `log.error({event: 'mcp-call-failed', cause: redact(e)})`), where every logged field passes through a typed redactor that knows which fields hold secrets. The cost is forcing every log site through the structured path; the benefit is no regex-misses.

The codebase chose the simpler tool because the secret shapes are small and known (five token formats), the log volume is route-scoped, and the redactor is centralized. If the system grew to log more variable data (per-customer fields, request bodies), the pattern set would have to grow alongside, and the right move at some scale is moving to typed-field redaction.

**Related industry concepts:**
- Secret scanning (GitHub, Gitleaks) — same pattern set, applied at commit time instead of log time.
- Structured logging (pino, winston with custom serializers) — typed-field redaction.
- Vault, AWS Secrets Manager — keeping secrets out of process memory in the first place; the cleanest defense (this codebase can't fully use it because OAuth tokens are *issued* per-session).

## Interview defense

**Q: Why pattern-based and not field-based?**
**A:** The secrets here arrive in unstructured text — Bearer headers in fetch error envelopes, OAuth-response JSON in non-2xx bodies, SDK cause chains assembled from many sources. There's no schema to attach a redactor to. Pattern matching is the right tool for unstructured text; structured logging would require routing every log through a typed surface, which this codebase doesn't have. The tradeoff is real: a token format the patterns don't know about leaks. The mitigation is keeping the pattern set tight against the secret shapes the system actually generates.

```
  unstructured text   ──► pattern redact
  structured fields   ──► field-typed redact (the cleaner alternative)
```

**Q: What's the load-bearing part people forget?**
**A:** `formatError`'s cause-chain walk. `String(e)` stops at the outer error; `console.error(e)` formats the chain via Node's inspector but ALSO bypasses your redactor. Without the explicit walk, a token nested two `.cause` deep — exactly where SDKs attach the original request envelope — survives the regex. The walk + the redactor together cover the chain.

**Q: Why redact at storage time in `makeCapturingFetch`?**
**A:** Defense in depth. Once the body sits in `holder.last`, downstream code (the error message assembler in `SdkTransport`) reads it without remembering the redaction contract. Redacting on write means even a future change that forgets to re-redact is still safe. Compare to redacting only on `console.error`: a single forgotten log site is a leak.

**Q: What does the redactor miss?**
**A:** Anything not Bearer-shaped or one of the four named OAuth fields. A custom API key in a `X-Custom-Key` header, a JWT smuggled into a query string, a base64-encoded credential in a body — all pass through. The set is the policy; growing the set is how the policy grows. The honest answer in an interview: "It catches the OAuth and Bearer shapes this codebase actually emits; if we added a third-party with a different auth scheme, we'd extend the pattern set the same day."

## See also

- `01-encrypted-auth-cookie.md` — the secrets the redactor exists to protect.
- `02-oauth-pkce-dcr-boundary.md` — where the OAuth tokens come from.
- `audit.md` § 4 (Secrets and configuration), § 5 (Data exposure and privacy).
- `lib/mcp/transport.ts:55-118` — the canonical implementation.
- Every `app/api/**/route.ts` — the call sites.
