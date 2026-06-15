# Refactor — extend `redactSecrets+formatError` to the 4 short MCP routes

> Source finding: `.aipe/audits/cleanup-2026-06-14T19-50-14.md` fix-now #1.
> Originating commit follow-up: `56e405b — fix(security): redact secrets from error.cause + Vercel logs (cleanup #2)`.

---

## What to refactor

Add `redactSecrets(formatError(e))` to the four MCP route `console.error` sites that still print the raw `e`. The two streaming routes already use this safe shape (`app/api/agent/route.ts:184`, `:302` and `app/api/briefing/route.ts:189`, `:288`); the four short MCP routes were missed by commit 56e405b. While doing this, lift the duplicated `formatError(e: unknown): string` helper out of `app/api/agent/route.ts:110` and `app/api/briefing/route.ts:80` and into a shared module so the four new import sites land on one definition, not a third copy.

**Target sites:**
- `app/api/mcp/call/route.ts:36` — `console.error('[mcp-call] error:', e);`
- `app/api/mcp/tools/route.ts:18` — `console.error('[mcp-tools] error:', e);`
- `app/api/mcp/tools/check/route.ts:22` — `console.error('[mcp-tools-check] error:', e);`
- `app/api/mcp/capture/route.ts:54` — `console.error('[mcp-capture] error:', e);`

---

## Why

Same info-disclosure trust-boundary class as cleanup #7 / commit 56e405b's intent: the raw `e` thrown out of `connectMcp`, `conn.mcp.callTool`, etc. carries `e.cause` (the captured response body) and `e.stack` straight into Vercel logs. The morning's commit shut this down on the two streaming routes but the four short MCP routes were not part of the diff. They are the same shape route handlers and they leak the same way — the commit message named these 4 sites as a follow-up. Closing the gap is the difference between "we redact secrets in error logs" and "we redact secrets in error logs, except for the four routes the cleanup pass missed."

A secondary motivation: shipping fix-now #1 without first lifting `formatError` would clone the helper to 6 routes instead of 2. Doing the lift inside this refactor caps the duplication count at 1 file.

---

## Target structure

**Step 1 — lift `formatError` to a shared module.** Move the helper from `app/api/agent/route.ts:110` and `app/api/briefing/route.ts:80` (two byte-identical copies) into `lib/mcp/transport.ts` next to `redactSecrets`, or into a new `lib/errors.ts` if `transport.ts` is the wrong home. Export it. Update the two streaming routes to import it instead of holding local copies.

**Step 2 — extend to the 4 MCP routes.** In each of `app/api/mcp/{call,tools,tools/check,capture}/route.ts`:

```
import { redactSecrets, formatError } from '@/lib/mcp/transport';
// or '@/lib/errors' depending on Step 1's home

// inside the catch block:
console.error('[mcp-call] error:', redactSecrets(formatError(e)));
```

The JSON response body to the client is already safe (commit 410e2bb stripped `e.stack` from the JSON; the body holds `e.message` only). This refactor is purely about what the *operator* sees in Vercel logs, not what the client sees.

**End state:**
- One `formatError` definition in the repo (was two).
- All six route handlers (`/api/agent`, `/api/briefing`, `/api/mcp/call`, `/api/mcp/tools`, `/api/mcp/tools/check`, `/api/mcp/capture`) log through `redactSecrets(formatError(e))`.
- No raw `e` reaches `console.error` from any route handler.

---

## Must not change

[BLANK — fill before execution]

---

## Must not introduce

[BLANK — fill before execution]
