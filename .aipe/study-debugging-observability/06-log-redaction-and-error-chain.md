# 06 — Log redaction + error-chain walk

**Secret-redaction and cause-chain flattening at log-string
construction** — Language-agnostic.

## Zoom out — where this concept lives

Every route's error path routes through two helpers before the log
line is emitted: `formatError` walks the `.cause` chain into one
string, `redactSecrets` scrubs OAuth / Bearer tokens from that string.
Both run *before* the string ever reaches `console.error` — so a token
in `err.cause.cause` doesn't leak into Vercel's log stream.

```
  Zoom out — the error redaction seam

  ┌─ Route error path (every route) ────────────────────────────┐
  │                                                              │
  │  } catch (e) {                                               │
  │    if (isClientCancel(e)) return                             │
  │    console.error('[agent] error:',                           │
  │        ★ redactSecrets(formatError(e)) ★  ← we are here       │
  │    )                                                         │
  │    send({ type: 'error', message: '...' })                   │
  │  }                                                           │
  └────────────────────────────┬─────────────────────────────────┘
                               │
                               ▼
                       Vercel log stream
                    (guaranteed token-free)
```

**Zoom in — what it is.** Two ~30-line pure functions. `formatError`
returns a flat string of `stack` + `caused by:` chain. `redactSecrets`
applies a fixed list of regex patterns to scrub known token shapes.
Both are called at every `console.error` in every route.

## Structure pass

**Layers.** Error object (raw, from the SDK / MCP / anthropic) ·
flatten (`formatError`) · scrub (`redactSecrets`) · sink
(`console.error`).

**One axis held constant: trust.** What's safe to log at each layer?

```
  "what fields in this string can leak a secret?"

  ┌───────────────────────────────────────┐
  │ error object: Error + .cause chain    │   → UNSAFE (any field)
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ formatError output: string          │   → STILL UNSAFE (join of unsafes)
      └─────────────────────────────────────┘
          ┌────────────────────────────────┐
          │ redactSecrets output: string    │   → SAFE (patterns scrubbed)
          └────────────────────────────────┘
              ┌────────────────────────────┐
              │ console.error(safe string)  │   → SINK receives sanitized
              └────────────────────────────┘

  redaction happens AT THE PRODUCTION SITE, not downstream.
  the log sink never sees an unredacted token.
```

**Seam.** The `redactSecrets(formatError(e))` call site. This is *the*
enforcement point — every route's error path uses this exact pattern.
It's compiler-enforced by convention, not by the type system, but a
grep for `console.error` across the routes finds only this shape.

## How it works

### Move 1 — the mental model

You know how a browser's devtools hide password inputs' contents even
when you inspect them? The design idea is: **don't ever put the
secret in a string that leaves your control.** In the browser it's the
input element treating the value specially. Here it's the log
production site running the string through a scrubber before it hits
the sink. The sink doesn't have to trust anything.

```
  The mechanism — flatten, then scrub, then log

     raw Error object                          "at connect (...)\n
     with .cause.cause                          Authorization: Bearer
     nested tokens                              eyJhbGc..."
     ─────────────────                          ────────────────────
              │                                          │
              │ formatError(e)                           │ redactSecrets(str)
              ▼                                          ▼
     flat string with                          "at connect (...)\n
     "\n  caused by: "                          Authorization: [redacted]"
     between layers                             ────────────────────
                                                          │
                                                          │ console.error
                                                          ▼
                                                   Vercel logs
                                              (token gone, context kept)
```

### Move 2 — the mechanism, step by step

**Part A — the cause-chain walker.** JavaScript errors can have a
`.cause` field (added in ES2022). MCP SDK + OAuth libraries nest
errors this way — the outer error says "Unauthorized," the inner
error carries the actual HTTP response with the token in the header.
`console.error(e)` formats causes via Node's `util.inspect`; but
`String(e)` doesn't. `formatError` fixes that.

Real code from `lib/mcp/transport.ts:78-97`:

```ts
/** Walk an error's `cause` chain into one string. `console.error(e)` formats
 *  nested causes via Node's util.inspect, but plain `String(e)` does not — so
 *  we assemble the chain ourselves before redacting, otherwise a token nested
 *  inside `e.cause.cause` would survive the redaction and reach Vercel logs. */
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

Two things to notice:

- `depth < 5` — bounded recursion. A cyclic cause chain (rare but
  possible if someone builds it wrong) can't hang the walker.
- `cur.stack ?? cur.message` — prefer the stack (which includes the
  message), fall back to message-only. The stack is what makes the
  log line diagnosable.

The doc comment names *why* this exists — not for style, for a specific
observed leak path: a token nested inside `e.cause.cause` would survive
if you only redacted the outer message. Flatten first, then redact.

**Part B — the pattern list.** Redacting means matching a fixed set of
known token shapes. Five patterns cover the OAuth + Bearer surface
Blooming actually depends on.

Real code from `lib/mcp/transport.ts:55-61`:

```ts
/** Patterns whose matches reveal a Bloomreach/OAuth credential. Bearer headers
 *  ride every MCP call and OAuth bodies carry token fields; when either ends up
 *  in `err.cause` (some failure modes attach the request envelope), the secret
 *  flows into the surfaced error detail and into Vercel logs. Redacting before
 *  the body is stored prevents the leak at the source. */
const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  /"access_token"\s*:\s*"[^"]+"/g,
  /"refresh_token"\s*:\s*"[^"]+"/g,
  /"id_token"\s*:\s*"[^"]+"/g,
  /"code_verifier"\s*:\s*"[^"]+"/g,
];
```

Every pattern is anchored to the shape the token appears in — either
an HTTP `Authorization: Bearer …` header string or a JSON key.
Wildcards are conservative (Bearer's charset is base64 + `._-+/=`;
JSON values are anything-not-quote). This is deliberately not a
regex-that-catches-all-secrets: false positives (over-redaction) are
fine, false negatives (missed tokens) are not.

**Part C — the scrubber.** Apply every pattern, replace with
`[redacted]` while preserving the surrounding JSON key so the log
stays readable.

Real code from `lib/mcp/transport.ts:66-76`:

```ts
/** Replace any token-shaped substring with `[redacted]`. Bearer matches collapse
 *  to a bare `[redacted]`; JSON field matches keep their key so the shape of the
 *  surrounding envelope stays readable (`"access_token":"[redacted]"`). */
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

The output shape is deliberately readable:
`"access_token":"[redacted]"` instead of a bare `[redacted]`. That
matters for debugging: you can still see *that* a token was in the
error envelope, at what key, without seeing the value. The context
that helps you diagnose is preserved; the secret is not.

**Part D — the call sites.** Every route's error handler uses the
exact same pattern. Grep across `app/api/`:

- `app/api/agent/route.ts:174` (setup error), `:317` (mid-stream
  error), `:330` (dispose error)
- `app/api/briefing/route.ts:179` (setup), `:303` (mid-stream), `:316`
  (dispose)
- `app/api/mcp/call/route.ts:37`, `app/api/mcp/tools/route.ts:19`,
  `app/api/mcp/tools/check/route.ts:23`,
  `app/api/mcp/capture/route.ts:55`

Every one is:

```ts
console.error('[agent] error:', redactSecrets(formatError(e)));
```

Same shape, same helpers, same guarantee. If anyone ever writes a new
route, the convention is documented by the six existing examples.

**Part E — the capturing fetch.** Redaction also applies at a
*different* seam: the MCP SDK's fetch wrapper. When the SDK's HTTP
request gets a non-2xx response, `makeCapturingFetch` stashes the
body in `HttpErrorHolder.last` so the transport can attach the *real*
server error text to the thrown tool error. But it redacts the body
first.

Real code from `lib/mcp/transport.ts:103-118`:

```ts
/** A fetch wrapper that records the body of any non-OK response into `holder`
 *  (cloning so the SDK can still read the original). Pass it to the SDK's
 *  StreamableHTTPClientTransport `fetch` option. The stored body is redacted
 *  first so a Bearer/OAuth token in an error envelope never reaches logs. */
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

Redaction happens *at capture time*, not at log time. The holder never
has an unredacted body. This is the "don't put the secret in a string
you don't fully control" principle applied one layer down.

### Move 2 variant — the load-bearing skeleton

The kernel:

```
  fixed regex list for known token shapes
  + flatten cause chain to string (bounded depth)
  + apply patterns at production site (not at log sink)
  + preserve envelope shape (key kept, value replaced)
```

- **Drop the cause-chain walk** and a nested error carries its token
  through — the outer redaction never sees the inner string.
- **Drop the depth bound** and a cyclic `.cause` chain hangs the
  walker.
- **Drop "redact at production site"** (redact at the log sink instead)
  and any code path that stringifies the error before logging bypasses
  the redaction. The transport's `HttpErrorHolder` is exactly this
  case — the token could reach the holder unredacted and be logged
  from a completely different call site.
- **Drop envelope preservation** and logs become uselessly opaque:
  `[redacted]` alone doesn't tell you an `access_token` was in the
  error at all.

Skeleton vs hardening:

- **Skeleton:** patterns + flatten + apply at production.
- **Hardening:** the bounded depth (safety); envelope preservation
  (readability); the ~5-item pattern list (deliberately narrow to
  avoid runaway false positives); the capturing-fetch integration
  (blocks the pre-log capture path).

### Move 3 — the principle

**Redact at the production site, not at the sink.** Every sink (log
stream, error tracker, distributed tracer) is a distinct trust
boundary; the more places the string travels through, the more
opportunities for it to leak. Enforce the invariant at construction:
the string that leaves the redaction helper is safe *forever*.

## Primary diagram

```
  Log redaction + error-chain walk — full picture

  ┌─ ERROR ORIGIN ─────────────────────────────────────────────────┐
  │                                                                 │
  │  MCP tool call fails:                                           │
  │    fetch(mcp.url, { headers: { Authorization: 'Bearer eyJ...'} })│
  │       │                                                         │
  │       ▼  401                                                    │
  │    makeCapturingFetch stashes body into holder:                 │
  │       ★ redactSecrets(body) BEFORE storage ★                    │
  │       holder.last = { status: 401,                              │
  │                       body: '{"error":"...", "hint":"[redacted]"}'}│
  │       │                                                         │
  │       ▼                                                         │
  │    SdkTransport.callTool catches, throws:                       │
  │       Error(`HTTP 401: {"error":...}`, { cause: originalErr })  │
  │                                                                 │
  └────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
  ┌─ ROUTE ERROR HANDLER ──────────────────────────────────────────┐
  │                                                                 │
  │  } catch (e) {                                                  │
  │    if (isClientCancel(e)) return                                │
  │                                                                 │
  │    ┌── formatError(e) ────────────────────────────────────┐    │
  │    │  parts = []                                           │    │
  │    │  cur = e; depth = 0                                   │    │
  │    │  while (cur && depth < 5) {                           │    │
  │    │    if (cur instanceof Error) {                        │    │
  │    │      parts.push(cur.stack ?? cur.message)             │    │
  │    │      cur = cur.cause                                  │    │
  │    │    } else { parts.push(String(cur)); cur = null }     │    │
  │    │    depth++                                            │    │
  │    │  }                                                    │    │
  │    │  return parts.join('\n  caused by: ')                 │    │
  │    └───────────────────────────────────────────────────────┘    │
  │                          │                                       │
  │                          ▼                                       │
  │    ┌── redactSecrets(str) ─────────────────────────────────┐    │
  │    │  for each TOKEN_PATTERN:                              │    │
  │    │    str.replace(match => {                             │    │
  │    │      if (match starts with 'Bearer')                  │    │
  │    │         return '[redacted]'                           │    │
  │    │      key = extract JSON key                           │    │
  │    │      return `"${key}":"[redacted]"`                   │    │
  │    │    })                                                 │    │
  │    │  return scrubbed                                      │    │
  │    └───────────────────────────────────────────────────────┘    │
  │                          │                                       │
  │                          ▼                                       │
  │    console.error('[agent] error:', scrubbed)                   │
  │    send({ type: 'error', message: `/api/agent · ${e.message}` })│
  │  }                                                              │
  │                                                                 │
  └────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
                       Vercel log stream
                       — no Bearer tokens
                       — no access_token values
                       — full stack trace + cause chain preserved
                       — one grep-able string per error
```

## Elaborate

This is the small end of the **PII / secret redaction** discipline
that shows up in every mature observability stack:

- Datadog has server-side scrubbers you configure with a regex list.
- Sentry has `beforeSend` hooks and default scrubbers for common PII.
- OpenTelemetry has span processors that can redact attribute values.
- Splunk has field-level masking rules.

The Blooming version is deliberately *client-side* (in the log
producer's process), not server-side. The reason: relying on Vercel's
log sink to scrub is a trust delegation; every deployment target
would need re-configuration; the leak surface expands with every
platform migration. Producing safe strings at the source means no
downstream configuration is required.

The cause-chain walk is subtle because JavaScript's error semantics
changed in ES2022 (adding `.cause`). Older polyfilled or transpiled
code may nest via `err.originalError` or `err.inner` instead. Today
Blooming only cares about `.cause` because that's what the MCP SDK,
`fetch` errors, and Anthropic SDK all use.

Adjacent concepts:

- **Structured logging** — the redaction pass is the last thing that
  runs before the string reaches a logger. If Blooming ever swaps
  `console.error` for a structured logger, `redactSecrets` still
  runs first.
- **Prompt / model input scrubbing** — a completely different problem
  (redacting user-provided secrets from prompts before they hit the
  model). Blooming doesn't do this today because inputs are
  synthetic or come from the anomaly definition, not from
  user-typed text.
- The MCP transport's HTTP error capture — `redactSecrets` runs
  there too, which means the leak is closed at *two* seams, not one.

## Interview defense

**Q: Why not just log `e.message` and skip the flatten?**

Because the interesting error content lives in `.cause`, not in the
outer message. `Error("Unauthorized").cause = originalHttpError`
would log as "Unauthorized" with no stack trace, no URL, no request
details. The flatten walks the chain so the log line contains
everything needed to diagnose.

Anchor: the doc comment at `lib/mcp/transport.ts:78-82` names the
exact leak path this defends against — a token in `e.cause.cause`
that would survive if you only redacted `e.message`.

**Q: Why redact at production, not at the sink?**

Because the sink is one specific place today (Vercel), but the
redaction promise has to hold across every future sink. If someone
adds Sentry tomorrow, or if a stack trace gets serialized into a
receipt file, the redaction has to have already happened. Producing
safe strings at the source means safety is *inherited* by every
downstream user of the string.

**Q: What if a new token type shows up that isn't in the pattern list?**

The list gets updated. The pattern list is a small, deliberately-narrow
set — it covers what Blooming actually uses today (Bearer, OAuth
fields). A new auth strategy that adds a new token shape would need to
extend the list. This is an audit issue, not a runtime one — it would
be caught by a code review of the new auth code.

The alternative — a broader "match any 32+ char base64 string" —
over-redacts real data (case IDs, UUIDs) and makes logs unreadable.

**Q: The depth cap on `formatError` — what problem does it solve?**

Cycle safety. A cause chain that loops (A.cause = B, B.cause = A) would
hang the walker without a depth bound. Five is plenty for real-world
errors (the deepest cause chain in the SDK is ~3 levels: outer error →
transport error → HTTP error) and cheap enough to be always-on.

## See also

- `03-per-phase-timing-log.md` — the summary log that fires from the
  `finally` block, *after* the redacted `console.error` from the
  `catch`.
- The MCP transport (`lib/mcp/transport.ts`) — the layer that both
  wraps the SDK's fetch (for capture) and provides the redaction
  helpers.
- `study-security` — the trust-boundary discussion of where tokens
  can leak and why redaction is the last-line defense, not the only
  one.
