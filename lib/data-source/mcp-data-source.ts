// lib/data-source/mcp-data-source.ts
//
// `McpDataSource` — the generic MCP client that powers the `live-mcp` mode.
//
// The class already existed as `BloomreachDataSource` and was, on inspection,
// generic (transport + retry ladder + TTL cache + spacing gate + AbortSignal
// composition). Renaming is done via re-export so all existing imports
// continue to compile. New code should prefer `McpDataSource` — the class is
// only "Bloomreach" in the sense that Bloomreach was its first user and
// still supplies the default retry-hint parser (which is HTTP-standard
// enough to work for other rate-limited servers too).
//
// This file is intentionally a thin re-export so the source of truth stays
// in one place. The plan's Phase 3 originally described extracting the class
// content into a new file; on close reading, the existing class is already
// the shape we want, and duplication would only introduce drift.

export {
  BloomreachDataSource as McpDataSource,
  McpToolError,
} from './bloomreach-data-source';

export type {
  CallToolOptions,
  CallToolResult,
  ListToolsOptions,
} from './bloomreach-data-source';
