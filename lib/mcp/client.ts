// lib/mcp/client.ts
//
// Backwards-compatibility shim — the implementation lives in
// `lib/data-source/bloomreach-data-source.ts` after the Phase 2 PR A seam
// extraction. This file kept so existing imports of `McpClient` /
// `McpToolError` / the option types compile unchanged while callers migrate
// to `BloomreachDataSource` / `DataSource` over time.
//
// New code should import from:
//   - `lib/data-source/types.ts`                  for `DataSource` (the seam)
//   - `lib/data-source/bloomreach-data-source.ts` for `BloomreachDataSource`
//   - this file ONLY for the legacy `McpClient` alias + `McpToolError`
export {
  BloomreachDataSource as McpClient,
  McpToolError,
  type CallToolOptions,
  type ListToolsOptions,
  type CallToolResult,
} from '../data-source/bloomreach-data-source';
