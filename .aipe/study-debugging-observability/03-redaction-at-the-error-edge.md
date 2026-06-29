# 03 — Redaction at the error edge

*Industry standard pattern: log redaction at the boundary where secrets enter the log pipeline, not at ingestion — combined with cause-chain walking so nested secrets are also redacted*

## Zoom out — where this concept lives

Tokens flow through every layer that touches Bloomreach. The cookie store carries them; the OAuth provider serializes them; the HTTP transport rides Bearer headers on every call; the error path can attach the request envelope to `err.cause`. If a token reaches `console.error`, it lives forever in Vercel log retention. The fix is to redact at the *last* point before the log call, not at log ingestion.

```
  Zoom out — where redaction sits

  ┌─ Service layer ─────────────────────────────────────────┐
  │  /api/briefing, /api/agent, /api/mcp/*                   │
  │  catch (e) {                                              │
  │    console.error(                                          │
  │      '[briefing] error:',                                   │
  │      ★ redactSecrets(formatError(e)) ★   ← we are here     │
  │    )                                                        │
  │  }                                                           │
  └────────────────────────┬─────────────────────────────────┘
                           │  redacted string
  ┌─ Vercel log retention ─▼─────────────────────────────────┐
  │  Bearer tokens, OAuth tokens never reach this layer       │
  └───────────────────────────────────────────────────────────┘
```

Zoom in — the concept. Two pure functions compose: `formatError(e)` walks the `err.cause` chain into one string, then `redactSecrets(text)` strips token-shaped substrings. Both are pure, both are tested, and both are called *at every single `console.error` site* in the routes. The sister function `makeCapturingFetch` runs `redactSecrets` even earlier — on the captured HTTP body, before it ever ends up in `HttpErrorHolder`. → file 04 covers the capture path.

## Structure pass

Axis: **where does the secret get stripped?**

- At log ingestion (the "log scrubber" pattern): Vercel/Datadog/Splunk runs regex over every line. Risk: scrubber misses a pattern, the secret is already in the retention bucket.
- At the log call (this repo): the string passed to `console.error` is already redacted. Vercel only ever sees the redacted form. Even if the scrubber fails, there is no secret to scrub.
- At the source (the strongest form): tokens never enter the error chain in the first place. The current repo is partly here (the `OAuthClientProvider` doesn't put tokens in error messages) and partly relies on this file's redaction (some SDK errors carry the request envelope).

Seam: the boundary where the answer flips is the `console.error` call. Above it (in the agent loop, the data source, the transport), tokens flow freely as part of doing work. Below it (Vercel log retention, third-party log shippers), no token should ever appear. The redaction call IS the seam — the contract is "any string passed to `console.error` from this codebase has already been through `redactSecrets`."

## How it works

### Move 1 — the mental model

You know how a logger middleware in Express might intercept every `res.send` to scrub credit-card numbers before they reach the client? Same pattern, except the "middleware" here is a manual function call that wraps every `console.error` argument, and the secrets are OAuth tokens instead of card numbers.

```
  Pattern — the redaction seam

           UNREDACTED (in code, in memory, in errors)
                            │
                            │  formatError(e)  — walk err.cause chain
                            ▼
                    one long string with secrets
                            │
                            │  redactSecrets(text)  — regex sweep
                            ▼
                   one long string with [redacted]
                            │
                            ▼
                       console.error(…)
                            │
                            ▼
              Vercel log retention (only sees redacted form)
```

The trick: a token has to pass through `redactSecrets` to be loggable. The discipline is by convention, not by type — every `console.error` call site in `app/api/` does this manually. The regression risk is a future `console.error` that forgets the wrapping; that's the gap a typed wrapper or an ESLint rule could close.

### Move 2 — step by step

#### The patterns: what counts as a secret

`lib/mcp/transport.ts:55-61`.

```ts
const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  /"access_token"\s*:\s*"[^"]+"/g,
  /"refresh_token"\s*:\s*"[^"]+"/g,
  /"id_token"\s*:\s*"[^"]+"/g,
  /"code_verifier"\s*:\s*"[^"]+"/g,
];
```

Five patterns. Three are OAuth JSON body fields (token grant response shape). One is the PKCE verifier (which is also secret — leaking it allows hijacking the authorization code exchange). One is the Bearer header form, which rides on every Bloomreach request.

Bridge: regex-based redaction is the workhorse of every log scrubber in the industry. It's not perfect — a novel token shape escapes — but it's deterministic, fast, and easy to extend by adding one more pattern.

What breaks if a pattern is missing: the token-shaped substring passes through `redactSecrets` unchanged and lands in Vercel logs. The literal incident this could happen on is a Bloomreach SDK version that wraps a request body into `err.cause` with a new field name like `"bearer_token"` instead of `"access_token"`. The mitigation is the integration test at `test/mcp/transport.test.ts` covering each pattern — extending the test alongside the pattern is the discipline.

#### The redactor: `redactSecrets`

`lib/mcp/transport.ts:66-76`.

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

Two replacement shapes:

- `Bearer abc.def.ghi` → `[redacted]` (the whole match collapses)
- `"access_token":"abc.def.ghi"` → `"access_token":"[redacted]"` (the JSON key is preserved so the surrounding envelope shape stays readable)

The key-preservation matters for diagnosis. When you grep Vercel logs for `"access_token":"[redacted]"`, you can tell a token-bearing JSON envelope appeared in the error — you just can't tell what the token was. That's the right tradeoff: enough structure to debug, no actual secret.

What breaks if the function isn't called: the text reaches `console.error` raw. Every other half of this file's design is undermined.

#### The cause-chain walker: `formatError`

`lib/mcp/transport.ts:82-97`.

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

The chain. A Bloomreach request fails → SDK throws `Error('Unauthorized')` → the transport wraps in `Error('HTTP 401: {"access_token":"…"}')` with `cause: <SDK error>` → the data source wraps in `McpToolError('list_tools', '…')` with `cause: <transport error>`. Three levels of `Error.cause` deep.

`console.error(e)` formats this chain via Node's `util.inspect`, but `String(e)` (which `redactSecrets` expects) returns only the outermost message. So a naive `console.error('[briefing] error:', redactSecrets(String(e)))` would redact only the outermost layer and miss a secret nested in `e.cause.cause`.

`formatError` walks the chain explicitly (up to depth 5), assembles every layer's stack/message into one string, and *then* hands it to `redactSecrets`. That's why secrets nested two `.cause`s deep still get caught.

Bridge: this is just `Error.cause` chain traversal — the same loop you'd write to print a nested exception in any language with chained errors. The novelty is doing it *before* logging, not letting the logger do it.

What breaks if the chain walk is missing: a token in `err.cause.cause.message` survives redaction and reaches Vercel logs. The integration test at `test/mcp/transport.test.ts` exercises the chained shape — drop the walker and the test fails.

#### The call sites — the actual discipline

Every `catch` in every route does this exact pattern. `app/api/briefing/route.ts:298-302` and `:310-311` and `:174-177`. `app/api/agent/route.ts:312-316` and `:324-325` and `:169-170`. `app/api/mcp/*/route.ts` similarly.

```ts
} catch (e) {
  console.error('[briefing] error:', redactSecrets(formatError(e)));
  send({ type: 'error', message: `/api/briefing · ${e instanceof Error ? e.message : String(e)}` });
}
```

Note: the `send({type:'error', message: …})` that reaches the wire is the *unredacted* outer message. This is deliberate — the UI shows the message to the user, and the outer message ("Anthropic API: 529 overloaded") doesn't carry secrets. Only the *full chain* sent to the server-side log goes through the redactor.

This is the trust boundary: the wire (UI-bound) gets the human-readable message; the log (operator-bound) gets the full chain. Different audiences, different content.

What breaks if a `catch` skips the redaction: a new route added without this pattern is the regression. The discipline is by-convention. The right move to harden it is either a typed wrapper (`logError(prefix, e)` that does the redact + format internally), an ESLint rule against bare `console.error(…, e)`, or both. Neither is in place today.

#### The upstream redaction — the body capture

`lib/mcp/transport.ts:103-118`. The capturing fetch redacts BEFORE storing the body in `HttpErrorHolder`. → file 04 covers this in depth. The point here: by the time the body reaches an `Error('HTTP 401: …')`, it's already been redacted once. Belt and braces — even if `redactSecrets` missed a pattern, the upstream redaction at body-capture time already stripped it.

### Move 3 — the principle

**Redact at the last point before the log call, never at log ingestion.** The argument for ingestion-time redaction is centralization; the argument against it is that any failure in the scrubber leaks the secret. Redacting before the log call means the log retention bucket never holds the secret, ever — even a scrubber bug can't leak what was never written. The cost is discipline at every `catch` site; the payoff is that the threat model collapses from "trust the log pipeline" to "trust two pure functions."

## Primary diagram

```
  the redaction edge, end to end

  Bloomreach 401 response (carries access_token in body)
   │
   ▼
  makeCapturingFetch:
    holder.last = { status: 401, body: redactSecrets(text) }   ← 1st redaction (at capture)
   │
   ▼
  SdkTransport.callTool: throws Error('HTTP 401: {"access_token":"[redacted]"}')
   │  (cause: SDK Error('Unauthorized'))
   │
   ▼
  BloomreachDataSource.liveCall: throws McpToolError('list_tools', 'HTTP 401: …')
   │  (cause: the transport Error above)
   │
   ▼
  Route catch (e):
    chain = formatError(e)                       ← walk .cause chain to depth 5
    redacted = redactSecrets(chain)              ← 2nd redaction (belt + braces)
    console.error('[briefing] error:', redacted)
   │
   ▼
  Vercel log retention
  ───────────────────────────────────────────────
  ✗ "Bearer abc.def.ghi"          (never present)
  ✗ "access_token":"abc.def.ghi"  (never present)
  ✓ "[redacted]"                  (what you see)
  ✓ "access_token":"[redacted]"   (key preserved for diagnosis)
```

## Elaborate

Where this pattern comes from: OWASP guidance on log injection / sensitive data exposure has named this for a decade. The combination of "pattern-based redaction" + "redact at source" is the standard recommendation. The cause-chain walk is newer — `Error.cause` is ES2022 — and most production loggers (pino, bunyan, zap, slog) handle it via their formatter, not via a pre-stringification pass.

Adjacent concepts: the body capture (file 04) is the upstream sister mechanism. The phase log (file 02) is what makes redaction operationally significant — without log retention there's no log to leak from. The auth cookie encryption in `lib/mcp/auth.ts:62-79` is the storage-time analog: tokens at rest in the cookie are AES-256-GCM encrypted, so even a stolen cookie doesn't yield plaintext tokens.

What to read next: a real-world failure mode this design defends against is the Heroku 2022 incident where access tokens leaked to logs via an exception path. The lesson — that "the logger is downstream of where the secret has to be stripped" — is the lesson this repo's design encodes.

## Interview defense

**Q: Why not just use a logger library that handles redaction automatically?**

Three reasons. First, this codebase doesn't have a logger library — it has `console.log` / `console.error`. Adding pino just for redaction is overkill at this scale. Second, library-level redaction is opaque — you trust the regex list, you don't get to read it. The seven lines of `TOKEN_PATTERNS` are auditable in one screen; an auditor can see exactly what's stripped and what isn't. Third, the cause-chain walk has to happen *before* the logger formats the error — most loggers handle chains internally and would redact post-format, which means an aggressive scrubber regex that catches stack-trace formatting tokens by accident. Doing it explicitly keeps the redaction surface narrow. Anchor: `lib/mcp/transport.ts:55-97`.

**Q: What if a future Bloomreach SDK version starts using `"bearer_token"` instead of `"access_token"`?**

The redaction misses it. The mitigation is layered:

```
  Layer                          | Catches new shape?
  ───────────────────────────────|──────────────────
  TOKEN_PATTERNS pattern match    | NO (regex doesn't match)
  Cookie encryption at rest       | YES (whole cookie encrypted)
  Body capture truncation 2KB cap | NO (still has the secret, just bounded)
  Outer message in `send({error:…})`| YES (outer message doesn't carry body)
```

The right fix is to add the pattern (a 1-line change in `TOKEN_PATTERNS`) and add a test fixture (a 5-line change in `test/mcp/transport.test.ts`). The pre-existing test suite at `test/mcp/transport.test.ts` is the regression guard — every shape we care about has a test that asserts redaction. The discipline is to grow the test set alongside the pattern set.

**Q: Why redact even though `Error.message` for an `McpToolError` looks safe?**

```
  McpToolError('list_tools', 'HTTP 401: ...')
      .message = "list_tools → HTTP 401: ..."   ← looks safe

  ...but .cause = the SDK Error, whose .stack might be:
  Error: Unauthorized
      at Client.callTool (.../sdk/client.js:42:11)
      ...full request envelope sometimes attached via cause.cause...
```

Two layers down, a token can show up in the request envelope. `formatError` walks both `cause` levels and assembles them into the string that `redactSecrets` sees. Trust the chain, not the outer message. Anchor: `lib/mcp/transport.ts:82-97`, plus the integration tests at `test/mcp/transport.test.ts`.

## See also

- `04-server-error-body-capture.md` — the upstream redaction: bodies are redacted at capture, so this file's redactor sees an already-once-redacted string by the time the error reaches the catch.
- `02-per-request-phase-log.md` — the phase log shares the same retention bucket; redaction is what makes putting structured logs there safe.
- `lib/mcp/auth.ts:62-79` — the at-rest redaction analog: AES-256-GCM encrypting the entire cookie store.
- `study-security` — the threat model that drove this design (Bloomreach alpha-server token leakage was a concrete observed risk).
