# Log secret redaction (walks the cause chain)

## Subtitle

Regex-based secret scrubbing over the recursive `error.cause` chain · Industry standard (log sanitization), Project-specific implementation (`redactSecrets` + `formatError`)

---

## Zoom out — where this concept lives

Every route in the trusted core has a `catch` block that logs the error. Errors from the MCP SDK, from `fetch`, from Anthropic — all of them can carry sensitive material in surprising places: the Bearer header echoed back in a 401 body, the `access_token` embedded in a request-envelope attached to `err.cause`, the PKCE `code_verifier` in a request that failed at the transport layer.

`console.error(e)` will happily serialize all of it into Vercel logs unless something scrubs first.

```
  Zoom out — where redaction sits

  ┌─ Service layer ──────────────────────────────────────────────┐
  │                                                                │
  │   ┌ Route catch block ────────────────────────────────────┐  │
  │   │  catch (e) {                                            │  │
  │   │    console.error(                                       │  │
  │   │      '[agent] error:',                                  │  │
  │   │      redactSecrets(formatError(e))  ★ THIS CONCEPT ★    │  │
  │   │    )                                                    │  │
  │   │  }                                                      │  │
  │   └─────────────────────────┬───────────────────────────────┘  │
  │                              │                                   │
  │                              │  scrubbed text                    │
  │                              ▼                                   │
  │                   ┌────────────────────┐                        │
  │                   │  Vercel log stream  │                        │
  │                   └────────────────────┘                        │
  │                                                                  │
  │   Companion path: makeCapturingFetch (transport.ts:103-118)     │
  │   redacts the HTTP error body BEFORE it enters the holder,      │
  │   catching secrets that would ride err.cause into the log.      │
  └────────────────────────────────────────────────────────────────┘
```

Two entry points, one scrubber. Every log line that carries an error goes through `redactSecrets(formatError(e))`; every captured HTTP body goes through `redactSecrets(body)` before it's stored. Two independent defenses landing on the same regex list.

---

## Structure pass — layers, axis, seams

**Layers.** Error thrown → `formatError` walks `.cause` chain → concatenated string → `redactSecrets` regex replace → `console.error`.

**Axis: what's untrusted in the log path?**

- The error message: sometimes safe, sometimes echoes a request header.
- The error's `.cause`: often a lower-level error with more raw material.
- Nested `.cause.cause`: the SDK layers cause depth 3-5 for MCP failures.
- The final string handed to `console.error`: anything at all could be in there.

**Seams.** Two:

1. **Error object → single string** — `formatError` collapses the cause chain into one message with `caused by:` separators. Nothing security-happens here; this is prep work so a single regex pass covers everything.
2. **String → scrubbed string** — `redactSecrets` runs the regex list. This is the decision seam: patterns match → tokens replaced with `[redacted]` (bare) or `"key":"[redacted]"` (keeping the field name for shape).

Hand off.

---

## How it works

### Move 1 — the mental model

You know how a git pre-commit hook can grep for AWS keys and reject the commit? Same idea, wrong direction: instead of rejecting, this rewrites. A regex list matches token-shaped substrings and replaces them in place. The output is a string that keeps enough context for debugging ("something authenticated failed with 401") but drops the credential itself.

The pattern's shape:

```
  Log redaction — the pattern

  raw error text
        │
        ▼
  ┌─────────────────────────────────┐
  │ walk cause chain, concat parts   │  (formatError)
  └────────────────┬────────────────┘
                   │  one big string
                   ▼
  ┌─────────────────────────────────┐
  │ for each pattern in list:        │  (redactSecrets)
  │   text = text.replace(re, mask)  │
  └────────────────┬────────────────┘
                   │  same shape, no credentials
                   ▼
             console.error
```

Two decisions in the mask function: full match → `[redacted]`, JSON field match → `"key":"[redacted]"` (keeping the key so the log line's shape is still readable).

### Move 2 — walkthrough

**The pattern list.** Five regexes, each targeting a specific token shape.

**File:** `lib/mcp/transport.ts`
**Constant:** `TOKEN_PATTERNS`
**Line range:** 55-61

```ts
const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  /"access_token"\s*:\s*"[^"]+"/g,
  /"refresh_token"\s*:\s*"[^"]+"/g,
  /"id_token"\s*:\s*"[^"]+"/g,
  /"code_verifier"\s*:\s*"[^"]+"/g,
];
```

One line per pattern; each named by what it defends:

- **`Bearer\s+...`** — the Authorization header. Every MCP call carries this. When a 401 comes back with the header echoed in the body ("token: `Bearer eyJhbGc...` is invalid"), this catches the echo.
- **`"access_token": "..."`** — appears in OAuth token-endpoint responses and in JWT introspection payloads. Any failure mode where a request/response envelope is attached to `err.cause` can leak this.
- **`"refresh_token": "..."`** — same source, longer-lived and higher-value if leaked. Refresh tokens can mint new access tokens.
- **`"id_token": "..."`** — OpenID Connect. Carries user identity claims; not sensitive as an auth credential (the audience is your app) but often carries email + sub. Redact defensively.
- **`"code_verifier": "..."`** — PKCE. If a token-exchange request fails and the SDK attaches the request envelope, the verifier lands in the log. Anyone with the verifier + `code` can complete the exchange.

The `g` flag means all matches in one string, not just the first. If a Bearer appears twice (say, both in the header and echoed in the body), both get scrubbed.

**The replace function.**

**File:** `lib/mcp/transport.ts`
**Function:** `redactSecrets`
**Line range:** 66-76

```ts
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

Two mask forms. The Bearer case collapses to a bare `[redacted]` because the surrounding structure is `Authorization: Bearer <token>` — the header name is already outside the match. The JSON case rebuilds `"key":"[redacted]"` so the log line is still valid-looking JSON and the reader can see *which* field was scrubbed.

The trust assumption named: the patterns are exhaustive for the token shapes this codebase deals with. If Bloomreach starts embedding tokens in a field named `"session_token"`, that field would pass through unredacted. Fix: add the pattern, add a test.

**The cause-chain walker.** The other half of the defense. `console.error(err)` will format nested causes via Node's `util.inspect`, but `String(err)` and `err.message` only give you the top level. If the sensitive token is at `err.cause.cause.body` (three-level deep from a wrapped MCP error), a naive `String(e)` skips it. `formatError` walks the chain explicitly.

**File:** `lib/mcp/transport.ts`
**Function:** `formatError`
**Line range:** 82-97

```ts
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

Named parts:

- **`depth < 5`** — cycle defense. `Error` objects can have circular `.cause` chains (though rare); bound the walk to prevent infinite loops. Five is a real limit for observed MCP failures.
- **`cur.stack ?? cur.message`** — prefer the stack because it carries the file/line context useful for debugging; fall back to message when the error was thrown without a stack (rare, e.g. from a plain `{ message: ... }` object treated as an error).
- **`.join('\n  caused by: ')`** — the format matches Node's own error printing style, so a reader used to seeing `caused by:` recognizes the chain.

What breaks if the walker skips `.cause`: a token in `err.cause.body` survives `redactSecrets` because it never enters `text`. The pattern *has* to see the substring to replace it.

**The two entry points into the scrubbers.**

**Entry 1: the log path in route catches.**

**File:** `app/api/agent/route.ts` (line 312), `app/api/briefing/route.ts` (similar), `app/api/mcp/{call,tools,capture}/route.ts` (each)

```ts
console.error('[agent] error:', redactSecrets(formatError(e)));
```

Same pattern in every route. `formatError` collapses; `redactSecrets` scrubs; `console.error` logs.

**Entry 2: the HTTP body capture.**

**File:** `lib/mcp/transport.ts`
**Function:** `makeCapturingFetch`
**Line range:** 103-118

```ts
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

This is the interesting one. The capturing fetch wraps the SDK's transport-level fetch (`connect.ts:79`) so that when a non-OK response comes back, the app can attach the real server body to the error it throws (`SdkTransport.callTool`, `transport.ts:141`). Without this, the SDK surfaces "Unauthorized" and the log line reads `SdkTransport error: Unauthorized` — useless for debugging.

The redaction happens at the *capture* moment, before the body is even stored. That means every subsequent code path — including the eventual log line via entry 1 — sees an already-scrubbed body. Defense in depth: even if `redactSecrets` at entry 1 misses a new pattern, the body coming into the log is already clean.

**Layers-and-hops for the full path:**

```
  A 401 with a bearer echoed in the body — end to end

  ┌─ MCP transport ──────────────────────┐  hop 1: HTTP  ┌─ Bloomreach ─┐
  │  StreamableHTTPClientTransport         │ ─────────►   │  server       │
  │  fetch = makeCapturingFetch(holder)    │              │  responds 401 │
  │                                        │ ◄─────────   │  body: "token │
  │                                        │  hop 2       │  Bearer eyJ.. │
  │                                        │              │  invalid"     │
  │  → makeCapturingFetch runs:            │              └───────────────┘
  │    holder.body = redactSecrets(body)   │  ★ first scrub
  │                                        │
  └─────────────┬──────────────────────────┘
                │
                ▼
  ┌─ SdkTransport.callTool ──────────────┐
  │  throw new Error(                       │
  │    `HTTP 401: ${holder.body}`,          │  body already clean
  │    { cause: originalErr }               │
  │  )                                      │
  └─────────────┬──────────────────────────┘
                │
                ▼
  ┌─ BloomreachDataSource ────────────────┐
  │  throw new McpToolError(name, detail,  │
  │    { cause: err })                     │
  └─────────────┬──────────────────────────┘
                │
                ▼
  ┌─ Route catch ─────────────────────────┐
  │  console.error(                        │
  │    '[agent] error:',                   │
  │    redactSecrets(formatError(e))       │  ★ second scrub, defense in depth
  │  )                                      │
  └────────────────────────────────────────┘
                │
                ▼
           Vercel logs (clean)
```

### Move 3 — the principle

Two rules generalize:

1. **Scrub at the earliest capture point.** Every layer that stores a substring of an external response should scrub before storing, not "eventually before logging." The earlier the scrub, the more downstream code is automatically covered.
2. **Walk the cause chain explicitly when the format matters.** `String(err)` gives you the surface; the interesting material often lives three levels deep. If your log lines need to be reader-friendly *and* clean, you own the walk.

The specific pattern here — regex list + `.replace` with a mask function — is not the strongest possible defense. A more paranoid version would parse structured logs (JSON everywhere) and strip fields by allowlist. This codebase logs plain strings, so string-scrubbing is the level that fits. The tradeoff: adding a new token shape means adding a regex; the alternative would mean re-plumbing every logger.

---

## Primary diagram — the full defense

```
  Log-side secret defense — every hop of the chain

  ┌─ Fetch layer ────────────────────────────────────────────────┐
  │  makeCapturingFetch(holder) wraps SDK's fetch                  │
  │                                                                │
  │  on !res.ok:                                                   │
  │    body = await res.clone().text()                             │
  │    body = body.slice(0, MAX_BODY)                              │
  │    body = redactSecrets(body)  ← scrub #1                     │
  │    holder.last = { status, body }                              │
  └────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
  ┌─ SDK / adapter layer ─────────────────────────────────────────┐
  │  SdkTransport.callTool                                         │
  │  throw new Error(`HTTP ${status}: ${holder.body}`, { cause })  │
  │       │                                                        │
  │       │ body is already scrubbed                               │
  │       ▼                                                        │
  │  BloomreachDataSource.callTool                                 │
  │  throw new McpToolError(name, detail, { cause: err })          │
  └────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
  ┌─ Route catch ─────────────────────────────────────────────────┐
  │  catch (e) {                                                   │
  │    formatError(e)                                              │
  │      ┌───────────────────────────────────────────────┐        │
  │      │  walk cause chain, depth ≤ 5                    │        │
  │      │  parts: [msg1, msg2, msg3, ...]                 │        │
  │      │  return parts.join('\n  caused by: ')          │        │
  │      └───────────────────────────────────────────────┘        │
  │                            │                                   │
  │                            ▼                                   │
  │    redactSecrets(text)  ← scrub #2                            │
  │      ┌───────────────────────────────────────────────┐        │
  │      │  for each pattern:                              │        │
  │      │    text = text.replace(pattern, mask)          │        │
  │      │  (Bearer → [redacted])                          │        │
  │      │  ("access_token":"..." → "access_token":"[redacted]") │  │
  │      └───────────────────────────────────────────────┘        │
  │                            │                                   │
  │                            ▼                                   │
  │    console.error('[agent] error:', scrubbed)                   │
  │  }                                                             │
  └───────────────────────────────────────────────────────────────┘
                             │
                             ▼
                     Vercel logs (clean)
```

---

## Elaborate

**Why regex and not a structured approach?** Because the input is unstructured. The error messages are strings built from network-level artifacts (HTTP status + body), and the body is whatever the upstream server chose to emit — sometimes JSON, sometimes plain text, sometimes a mix. Structured redaction would need a parse-first pass and then wouldn't help on the "plain text body" case. Regex is the tool that fits the shape of the input.

**Why not a broader pattern like `/[a-zA-Z0-9]{40,}/g`?** Too broad. Session IDs, insight UUIDs, log correlation IDs would all match. The value of the log line is the identifiers that let you correlate; scrubbing them defeats the purpose. Narrow patterns keyed off the field name or the `Bearer` prefix preserve everything except the actual credential.

**What about response bodies going to the client?**

**Half-covered.** The captured body from `makeCapturingFetch` is scrubbed before it enters the `holder`, so every downstream code path — including the client response — sees the clean version. Good.

But: the route catches also emit an NDJSON `error` event to the client with `message: '/api/agent · ' + e.message`. That message is NOT passed through `redactSecrets` on the response side. If a future error shape carries a token in `e.message` directly (not in `e.cause`), it reaches the client. See `audit.md` § 5 red flag #10. The fix: route the error message through `redactSecrets` on both the log side AND the response side (or, equivalently, do the redaction inside `formatError` so all downstream users of its output are covered).

**Where the pattern originated.** Log sanitization is decades old. The specific "walk the cause chain then regex-scrub" combo is folklore from anyone who's dealt with a Node.js SDK that layers errors — it's the shape you land on after your third "there was a token in the log again" incident.

**Adjacent concept in this repo:** `truncate` (`lib/agents/base-legacy.ts:34-37`, `route.ts:98-101`) — different intent (bound log/response size), same shape (in-string transform before emission). The two often live together in log pipelines.

**What to read next in this repo:** `01-encrypted-cookie-auth-store.md` — the storage side of the same tokens; `02-oauth-pkce-with-dcr.md` — where the tokens come from in the first place.

---

## Interview defense

### Q: "Why walk the cause chain? Isn't the top-level message usually enough?"

**Answer:** No, and here's why it burned us. `console.error(err)` uses Node's util.inspect internally, which walks causes. `String(err)` and `err.message` do NOT — you get only the top level. If a token is at `err.cause.cause.body` (three-deep, which happens with wrapped MCP errors), a naive `String(e)` skips it entirely: the log line looks clean, but nothing was actually scrubbed because the scrubber never saw the deep string.

`formatError` walks the chain explicitly, concatenates with `caused by:` markers (matching Node's format), and hands one big string to the regex pass. Now the regex sees every layer.

**Diagram:**

```
  Naive String(err):               formatError walks:
  ─────────────────                ──────────────────
  "MCP tool failed"                "MCP tool failed
                                    caused by: HTTP 401: token
                                    Bearer eyJ... invalid
                                    caused by: fetch failed"
        │                                    │
        ▼                                    ▼
  regex sees nothing                regex catches Bearer
  interesting → looks clean         → actually redacts
  but wasn't scrubbing anything
```

**Anchor:** `lib/mcp/transport.ts:82-97` — the walker with `depth < 5` cycle defense.

### Q: "You have two redaction points — capture time and log time. Isn't one enough?"

**Answer:** Enough for the current threat, but defense in depth is cheap here. Capture-time redaction (`makeCapturingFetch`) catches the specific case where the SDK's transport thrown-error carries an echoed Bearer in the body. Log-time redaction catches anything else — a token stashed in an env-var-derived error message, a stack trace that includes a config object, a new leak vector I haven't thought of.

More concretely: adding a new token pattern means adding a regex to `TOKEN_PATTERNS`. Every log site that uses `redactSecrets` is automatically covered. Every capture site that uses `redactSecrets` is automatically covered. One place to update, two defenses maintained. That's the value of the belt-and-braces.

**Anchor:** `lib/mcp/transport.ts:103-118` (capture-time), route catches (log-time, e.g. `app/api/agent/route.ts:312`).

### Q: "What would break this?"

**Answer:** Three things:

1. **A new token shape not in the pattern list.** Bloomreach adds a `"session_token"` field to their error envelopes; the current list doesn't match. Log leaks until the pattern is added. Fix: add a test that emits every documented token field and asserts each redacts.
2. **A token embedded outside the field-value shape.** If a message says `"your token 'eyJhbGc...' has expired"`, the JWT-looking substring isn't inside a `"field":"..."` pattern, so nothing matches. This is real — the classifier would need a JWT-shaped regex OR the message would need to be rephrased upstream. Currently: no known instance in this codebase's error paths.
3. **A response error message that bypasses `formatError`.** The route response-side `send({ type: 'error', message: '/api/agent · ' + e.message })` uses `e.message` directly. Not passed through the scrubbers. See `audit.md` § 5 red flag #10 for the exact fix.

**Anchor:** `lib/mcp/transport.ts:55-61` (the pattern list — the surface area).

---

## See also

- `01-encrypted-cookie-auth-store.md` — the storage-side defense for the same tokens
- `02-oauth-pkce-with-dcr.md` — where the tokens originate and how they flow across the redirect
- `04-model-output-type-guards.md` — a different "untrusted input at a boundary" story
- `audit.md` § 4 (secrets and configuration) — the lens finding; § 5 red flag #10 — the response-side gap
