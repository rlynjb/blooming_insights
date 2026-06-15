# Refactor: Strip e.stack from JSON error response bodies

## What to refactor

Four route catch blocks, all using the same drift pattern:

- `app/api/mcp/call/route.ts:18` — `e instanceof Error ? \`${e.message}\n${e.stack ?? ''}\` : String(e)`
- `app/api/mcp/tools/route.ts:19` — same shape
- `app/api/mcp/tools/check/route.ts:23` — same shape
- `app/api/mcp/capture/route.ts:55` — same shape

The streaming routes (`app/api/briefing/route.ts:247-252` and `app/api/agent/route.ts:255-260`) already use the *correct* shape: `console.error(e)` in the server log + `e.message` in the wire — they're the in-repo reference.

## Why

This is the trust-boundary fix the prior audit called for — and didn't get done (cleanup-2026-06-02 fix-now #3, `study-security/audit.md` Top-3 #2). Concatenating `e.stack` into the JSON response leaks:

- Project file paths (e.g. `/var/task/lib/mcp/transport.ts:47`)
- Library entry points (the @modelcontextprotocol SDK's internal call frames)
- Function names, line numbers, the SDK version implicitly via stack shape

…to anyone who can hit the route. On Vercel that's anyone on the internet who finds the URL.

Severity: high. Effort: 4 single-line edits across 4 files (one per route). No control-flow change. Behaviour stays identical for clients who only read `body.error` — the stack frames simply disappear from the wire, while `console.error(e)` keeps the full stack in the operator's Vercel logs (which is where it belongs).

## Target structure

Each catch becomes the two-statement pattern the streaming routes already use:

```
} catch (e) {
  console.error('[<route-name>] error:', e);
  return NextResponse.json(
    { error: e instanceof Error ? e.message : String(e) },
    { status: 500 },
  );
}
```

The `[<route-name>]` prefix matches what `app/api/briefing/route.ts:248` does (`'[briefing] error:'`) — operator log search reads as `route → message`.

Behaviour-preserving claim: the wire format remains `{ error: string }` with status 500, identical to what callers see today minus the stack tail. No caller in this codebase indexes into the stack-tail substring (the client UI only reads `body.error` and lowercase-matches it for the auth-class), so there is no consumer behaviour to preserve.

## Must not change

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->

## Must not introduce

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->
