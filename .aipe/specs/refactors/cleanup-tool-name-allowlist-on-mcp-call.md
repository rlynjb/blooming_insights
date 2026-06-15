# Refactor: Tool-name allowlist on POST /api/mcp/call

## What to refactor

- `app/api/mcp/call/route.ts:5-22` — the entire POST handler. Specifically the body parse at `:7` and the unguarded `conn.mcp.callTool(name, args ?? {})` at `:13`.
- Imports: the tool-name lists already exist as exported constants in `lib/mcp/tools.ts` — `monitoringTools`, `diagnosticTools`, `recommendationTools`, `bootstrapTools`. They're the single source of truth for "tools this app intends to call."

## Why

The route at `app/api/mcp/call/route.ts` is the only HTTP-exposed surface that passes a user-provided `name` straight into `mcp.callTool` (`study-security/05-open-tool-surface-gap.md`, cleanup-2026-06-02 fix-now #4). Today the only Bloomreach tools are read-only (analytics + schema), so the worst case is a user enumerating tool names — recon-level surface risk. The moment Bloomreach adds a write tool (a webhook trigger, a segment write, a voucher issue), this route silently inherits the new capability with zero code change. The allowlist is the contract that prevents that — capability gating, declared at the boundary, in the language the rest of the system already speaks (the tool-name constants in `lib/mcp/tools.ts`).

Severity: high (by recon's "the audit must name the path even when the trigger is gated by other auth"). Effort: one Set + one guard, ~10 LOC.

## Target structure

At module scope (so the Set is built once per warm instance):

```
import { monitoringTools, diagnosticTools, recommendationTools, bootstrapTools } from '@/lib/mcp/tools';

const ALL_KNOWN = new Set<string>([
  ...monitoringTools, ...diagnosticTools, ...recommendationTools, ...bootstrapTools,
]);
```

Inside POST, right after `const { name, args } = await req.json()`:

```
if (typeof name !== 'string' || !ALL_KNOWN.has(name)) {
  return NextResponse.json({ error: 'tool not allowed' }, { status: 403 });
}
```

Behaviour-preserving claim: the `/debug` UI is the only known caller and it only ever invokes tools from those four lists, so its experience is unchanged. Every other caller — present or future — sees a 403 instead of an unsanctioned `mcp.callTool`. The new rejection is *added safety*, not a behaviour change to existing callers.

## Must not change

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->

## Must not introduce

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->
