# 06 — secret-redaction-in-errors

**Industry name(s):** Secret / credential scrubbing (log hygiene);
error-envelope redaction; cause-chain walking. Type: Industry standard.

## Zoom out — where this concept lives

Errors from the MCP transport can include the request/response envelope
in their `cause` chain. That envelope carries the `Authorization: Bearer …`
header on every call, and OAuth token endpoint bodies carry `access_token` /
`refresh_token` / `code_verifier` in JSON. Without redaction, those secrets
land in `console.error` output → Vercel logs → whoever has log access.

```
  Zoom out — where the redaction sits

  ┌─ MCP SDK (StreamableHTTPClientTransport) ─────────┐
  │  request carried Authorization: Bearer <token>     │
  │  response body echoed for error context            │
  │  error.cause = { req, res, body: "…access_token…"} │
  └────────────────────┬──────────────────────────────┘
                       │
  ┌─ transport.ts ─────▼──────────────────────────────┐
  │  makeCapturingFetch: cache last-error body         │
  │    holder.last.body = redactSecrets(...)  ★        │
  │                       ← redacted BEFORE storage    │
  └────────────────────┬──────────────────────────────┘
                       │  error propagates
  ┌─ route.ts ─────────▼──────────────────────────────┐
  │  console.error(redactSecrets(formatError(e)))      │
  │                 ← belt-and-braces on the log path  │
  └────────────────────┬──────────────────────────────┘
                       │  wire error → client
  ┌─ NDJSON stream ────▼──────────────────────────────┐
  │  { type: 'error', message: e.message }             │
  │   ← only the top-level .message, not the cause     │
  └───────────────────────────────────────────────────┘
```

Redaction fires at two points: at capture time (before the body is even
stored) and at log time (before console.error prints). Belt-and-braces —
either alone would leave one route to logs.

## Structure pass

**Layers.** SDK error → captured response body → error propagation →
console.error → Vercel logs.

**Axis: trust — where does credential-shaped text lose its ability to reach
the log?**

```
  One axis — trust — the redaction fence

  SDK error:       plaintext bearer / OAuth fields in .cause envelope
      │
  makeCapturingFetch: intercepts non-2xx response body
      │      ├─ clone the response (so SDK can still read it)
      │      ├─ .text() to string
      │      ├─ slice to MAX_BODY (2000 bytes)
      │      └─ redactSecrets ★
      ▼
  holder.last.body = REDACTED string (Bearer → [redacted], etc.)
      │
  SdkTransport.callTool: on failure, throw with the redacted body attached
      │
  route.ts catch: console.error(redactSecrets(formatError(e)))
      │                          ★ second pass ★
      ▼
  Vercel logs:  Bearer patterns collapsed to [redacted]
                 "access_token":"[redacted]"
                 "refresh_token":"[redacted]"
                 "code_verifier":"[redacted]"
```

**Seams that matter.**

  → `makeCapturingFetch` (`lib/mcp/transport.ts:103-118`) — first fence.
    The captured body is redacted before it's stored, so nothing
    downstream needs to trust the caller to redact again.
  → `console.error(redactSecrets(formatError(e)))` at route layer — second
    fence. Catches any secret that slipped in via a `cause` chain that
    bypassed the capturing fetch.

## How it works

Two collaborating pieces: a pattern-based scrubber and a cause-chain
walker. The scrubber knows how to recognize a secret; the walker makes
sure the scrubber sees every layer of the error.

### Move 1 — the mental model

You've written a `String.replace(/pattern/g, replacement)` before. That's
the whole scrubber, applied to five patterns. The subtlety is the walker
— errors nest via `.cause`, and `String(e)` doesn't show the cause chain,
so if you don't walk it yourself the redaction never sees the inner
layers where the secret lives.

```
  The redaction kernel — walk causes, then scrub every pattern

    error
      │  .cause?
      ▼
    error.cause
      │  .cause?
      ▼
    error.cause.cause      → concat all layers into one string
      │  (limit depth)
      ▼
   walk done ──────► redactSecrets(text)
                       │
                       ├─ /Bearer <token>/       → [redacted]
                       ├─ /"access_token":"…"/   → "access_token":"[redacted]"
                       ├─ /"refresh_token":"…"/  → "refresh_token":"[redacted]"
                       ├─ /"id_token":"…"/       → "id_token":"[redacted]"
                       └─ /"code_verifier":"…"/  → "code_verifier":"[redacted]"
                       │
                       ▼
                   redacted string → console.error
```

### Move 2 — the step-by-step walkthrough

**The patterns — five secrets, matched loosely by shape.**

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

  → Bearer — matches `Authorization: Bearer <token>` including URL-safe
    base64 padding.
  → The four JSON field patterns cover both OAuth token endpoint responses
    and any error envelope that leaks the token exchange.
  → All are `/g` (global) so multiple occurrences in the same string all
    get replaced.

**The scrubber — replaces per pattern, keeps the JSON key visible.**

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

Design choice: don't collapse the JSON field to a bare `[redacted]`. Keep
the field name visible.

```
  Before:  {"error":"invalid_token","access_token":"eyJhbGc..."}
  After:   {"error":"invalid_token","access_token":"[redacted]"}
```

The reason: an error envelope with the field names intact is diagnosable
("ah, this was the token refresh call — the field names tell me"). One
where every field collapses to `[redacted]` loses the surrounding shape
too — you can't tell if the redaction fired on a token exchange or on
some other place tokens travel.

**The cause-walker — `console.error` shows this; `String(e)` doesn't.**

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

Depth-5 cap so a pathological error graph can't loop or explode. Each
layer joins with `caused by:` so the log line reads top-to-bottom like
a stack chain.

Why this exists: `console.error(e)` in Node uses `util.inspect`, which
walks causes. But if you do `console.error(String(e))` or the error
crosses a `throw new Error(msg, { cause: e })` boundary and gets caught
somewhere generic, only the top layer prints. `formatError` guarantees
every layer becomes text, so redaction gets to see every layer.

**Where redaction fires — two places.**

**Fence 1: at capture.**

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
        };                                        ★
      } catch {
        /* body unreadable / already consumed — leave the holder as-is */
      }
    }
    return res;
  };
}
```

The captured body is redacted BEFORE storage. So even if some code later
inspects `holder.last.body` and dumps it verbatim, the token is already gone.

**Fence 2: at log.**

```ts
// app/api/agent/route.ts:174, 317
console.error('[agent] setup error:', redactSecrets(formatError(e)));
console.error('[agent] error:', redactSecrets(formatError(e)));
```

```ts
// app/api/agent/route.ts:330
console.error('[agent] dispose error:', redactSecrets(formatError(disposeErr)));
```

Every `console.error` for MCP-adjacent errors runs through the pair. Same
pattern in `/api/briefing/route.ts`.

**What reaches the client.** The NDJSON stream sends only `.message`:

```ts
// app/api/agent/route.ts:317-321
send({
  type: 'error',
  message: `/api/agent · ${e instanceof Error ? e.message : String(e)}`,
});
```

`.message` is the top-level Error's message string, not the cause chain
or the response body. The token-shaped strings live in `.cause`; the wire
message is typically a short "HTTP 401: invalid_token" or similar. Even
so — the redaction fence at log time provides defense-in-depth against a
future error type that packs the raw envelope INTO `.message`.

### Move 2 variant — the load-bearing skeleton

The kernel: **walk causes → concatenate → pattern-replace → then log.**

  → Drop the cause walker and secrets inside `err.cause.cause` never see
    the redaction pass. Vercel logs get the raw string.
  → Drop the capturing-fetch redaction and any code path that reads
    `holder.last.body` without re-redacting leaks. Belt-and-braces means
    both redact.
  → Drop the depth cap and a self-referential error graph loops.
  → Drop the `String.startsWith('Bearer')` branch and Bearer tokens
    collapse to `"":"[redacted]"` which is uglier and slightly less
    diagnostic (loses the "this was the Authorization header" signal).
  → Add a new secret pattern (e.g. `"private_key"`) and forget to add
    it to `TOKEN_PATTERNS` — the secret leaks. This is the maintenance
    risk with pattern-based scrubbers.

Hardening on top: MAX_BODY = 2000 byte cap on stored bodies (bounds the
scrubber's work), the depth-5 cap on cause walking, the try/catch in
`makeCapturingFetch` that keeps a body-read failure from throwing over
the original error.

### Move 3 — the principle

**Redact at write time to the log substrate, not at read time from it.**
Once a secret is in a log stream, it's someone else's problem to strip
it. The right fence is between "we have the secret in memory" and "we
write it out." Two fences (capture + log) beat one because they cover
different error propagation paths — the capture fence catches SDK-internal
error bodies; the log fence catches anything that assembled a string
before hitting console.

## Primary diagram

```
  Full picture — a failed MCP call, from HTTP response to Vercel log

  ┌─ Bloomreach MCP server ───────────────────────────┐
  │  401 Unauthorized                                  │
  │  body: {"error":"invalid_token",                   │
  │         "access_token":"eyJhbGciOi..."}            │
  └────────────────────┬──────────────────────────────┘
                       │
  ┌─ makeCapturingFetch ▼──────────────────────────────┐
  │  res.ok? no → capture:                             │
  │    ┌─ clone + .text() → raw body string           │
  │    ├─ .slice(0, 2000) → bounded                   │
  │    └─ redactSecrets → "…\"access_token\":\"[redacted]\""│
  │  holder.last = { status: 401, body: <REDACTED> }   │
  └────────────────────┬──────────────────────────────┘
                       │
  ┌─ SdkTransport.callTool ▼──────────────────────────┐
  │  SDK throws (auth error)                          │
  │  wrap with captured body:                          │
  │    throw new Error(`HTTP 401: ${captured.body}`,   │
  │                    { cause: err });                │
  └────────────────────┬──────────────────────────────┘
                       │  Error(message, {cause: original})
  ┌─ route.ts catch ────▼──────────────────────────────┐
  │  formatError(e):                                   │
  │    layer 0: "HTTP 401: …[redacted]…"               │
  │    layer 1 (cause): original SDK Error stack       │
  │    layer 2 (cause.cause): possibly the raw req     │
  │    → join with "caused by:"                        │
  │                                                    │
  │  redactSecrets(joined):                            │
  │    scrub any Bearer/OAuth patterns in any layer    │
  │                                                    │
  │  console.error('[agent] error:', redacted)         │
  └────────────────────┬──────────────────────────────┘
                       │
  ┌─ Vercel logs ──────▼──────────────────────────────┐
  │  [agent] error: HTTP 401: {"error":"invalid_token",│
  │  "access_token":"[redacted]"}                      │
  │    caused by: <SDK stack with Bearer [redacted]>   │
  └───────────────────────────────────────────────────┘
```

## Elaborate

Where the pattern comes from: log scrubbing / credential redaction is a
standard SDK concern (Datadog scrubbers, Sentry beforeSend filters, GCP
Cloud Logging redaction rules). Most cloud logging platforms offer
managed redaction — this repo does it in code because the Vercel log path
is `console.*` → Vercel's log ingest, with no in-transit hook.

Related patterns:

  → **Secret vaults.** For persisted secrets, don't touch them in code —
    reference them by identifier and let a vault (AWS Secrets Manager,
    Vercel Env, HashiCorp Vault) hand them out at boundary. This repo's
    OAuth tokens sit in the AES-256-GCM cookie; API keys sit in Vercel
    env. The redaction pattern here covers the *in-flight* window: when
    a secret has to be sent over the wire and might come back in an
    error envelope.
  → **Structured logging.** If logs were JSON-shaped, you could redact by
    field name at ingest instead of by regex on flat text. This repo
    uses `console.log(JSON.stringify(...))` for the phase-log line
    (structured) and `console.error(...)` for errors (flat text), so
    the regex approach is the right fit for the error path.
  → **Denyfields at boundary.** A stricter version: never let a secret
    reach the log path at all. `err.cause` never gets logged. This is
    hard because `err.cause` is where all the diagnostic value lives —
    the tradeoff you make is "log for debugging AND redact at write."

**A note on how the tests prove this.** The `redactSecrets` and
`formatError` seams are pure functions, testable without network. The
test suite (261 tests) exercises the redaction with real token shapes.
Because both are inputs-in / string-out, adding a new secret pattern
means adding a test case that verifies the pattern collapses.

## Interview defense

**Q: Why redact at write time instead of at ingest?**

A: Once the secret is in Vercel's log ingest, it's downstream of my
control — Vercel's retention policy, Vercel's log-view permissions,
whoever exports the logs to a SIEM. Redacting before `console.error`
returns is the last point where I have full control. It's the same
argument as "encrypt at rest" versus "trust the disk" — control the
point that's still under your hand.

Anchor: `lib/mcp/transport.ts:66-76` (the scrubber),
`app/api/agent/route.ts:174, 317` (the call sites).

**Q: Regex-based scrubbing feels fragile. What if the model returns a
new token shape?**

A: It's fragile — that's the honest tradeoff for a five-line scrubber
with zero deps. Two mitigations. First, the patterns are anchored to
well-known OAuth field names (`access_token`, `refresh_token`,
`id_token`, `code_verifier`) that don't change; the format is fixed by
RFC 6749. Second, Bearer is the *transport* form and covers most
credential leakage independent of what the underlying token shape is.
Where this would break: a custom auth scheme with an ad-hoc header name
(`X-My-Company-Auth: some-format`). Fix: add the pattern. The
maintenance risk exists; it's called out in the load-bearing skeleton.

A more durable design would use a secret vault + secret references — but
that's overkill for this repo's surface (one OAuth flow, one bearer
alternative, one API key).

Anchor: `lib/mcp/transport.ts:55-61` (the pattern list).

**Q: What happens if the response body is bigger than MAX_BODY?**

A: `.slice(0, 2000)` truncates before storage. Two consequences.
First, the redaction only sees the first 2KB — a secret at byte 2001+
survives unredacted in the response BODY (but not in the SDK's error
envelope, which typically wraps the truncated one). Second, most OAuth
error envelopes are well under 2KB, so this bound almost never fires in
practice. The choice buys: bounded work per error (regex on 2KB is
fast), bounded log line size (Vercel truncates long lines anyway). The
alternative (unbounded scrubbing) would be more thorough but risks a
DoS-like log explosion on a runaway error envelope.

Anchor: `lib/mcp/transport.ts:27` (MAX_BODY) and `:108-110` (the slice).

## See also

- `01-encrypted-auth-cookie.md` — where the bearer token lives at rest
- `03-user-chosen-mcp-url-boundary.md` — the new bearer surface Session D introduces
- `audit.md` §4 — the secrets lens overall
