# Refactor: Redact secrets from error.cause / captured HTTP bodies

## What to refactor

- `lib/mcp/transport.ts:24-36` — `makeCapturingFetch`. The current code stores up to `MAX_BODY = 2000` bytes of any non-OK response body unredacted into `holder.last.body`. That body then flows into `throw new Error('HTTP ${captured.status}: ${body}', { cause: err })` at `lib/mcp/transport.ts:54-56`.
- `lib/mcp/client.ts:55-62` — `errorDetail` `JSON.stringify`s the cause chain into the surfaced detail. Anything in the cause is now in the UI error message and (more importantly) in any `console.error(e)` log.
- `app/api/briefing/route.ts:248` and `app/api/agent/route.ts:256` — the two `console.error('[…] error:', e)` lines that print the full error including cause.

## Why

The Bloomreach token is a Bearer header on every MCP call. When the SDK or fetch layer throws with the request envelope attached (some failure modes do this), the bearer string lands in `err.cause`. From there it flows to (a) the user-facing error string via `errorDetail` → `McpToolError.detail` and (b) the Vercel server logs via `console.error(e)`. **A token in Vercel logs is a secret in logs** — same disclosure as committing it to git (cleanup-2026-06-02 fix-now #7, `study-security/audit.md` finding C7).

This finding pairs with #3 (strip e.stack) as a cluster — both are "what gets logged where." But unlike #3, this is the more dangerous half: a leaked stack trace exposes structure; a leaked token exposes capability.

Severity: high if it fires. Effort: one regex + one wrapper, ~10 LOC.

## Target structure

Add `redactSecrets` next to `MAX_BODY` in `lib/mcp/transport.ts`:

```
const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,                       // Authorization headers
  /"access_token"\s*:\s*"[^"]+"/g,                       // JSON token fields
  /"refresh_token"\s*:\s*"[^"]+"/g,
  /"id_token"\s*:\s*"[^"]+"/g,
  /"code_verifier"\s*:\s*"[^"]+"/g,                      // PKCE leaks
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}
```

Wire it into the two paths that surface bodies:

1. `makeCapturingFetch` — redact before storage:
   ```
   holder.last = {
     status: res.status,
     body: redactSecrets((await res.clone().text()).slice(0, MAX_BODY)),
   };
   ```

2. The two `console.error('[…] error:', e)` lines in `app/api/briefing/route.ts:248` and `app/api/agent/route.ts:256` — wrap the error formatter so the cause chain is redacted *before* it hits the log:
   ```
   console.error(`[briefing] error:`, redactSecrets(formatError(e)));
   ```
   where `formatError(e)` walks `e.message` + `e.cause?.message` + `e.cause?.cause?.message` into a single string. (Or, simpler: redact `String(e)` if Node's default Error toString is enough.)

Behaviour-preserving claim: the only thing redaction changes is the visible text in two places — `holder.last.body` (consumed by `SdkTransport.callTool` for error tagging) and the Vercel `console.error` lines. The user-visible error becomes `HTTP 401: {"error": "Bearer [redacted]"}` instead of `HTTP 401: {"error": "Bearer eyJ…"}` — same status, same message shape, sensitive substring replaced. No control flow, no API surface change.

## Must not change

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->

## Must not introduce

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->
