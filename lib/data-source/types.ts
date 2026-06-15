// lib/data-source/types.ts
//
// The DataSource seam — abstract surface every backend (Bloomreach today,
// Olist tomorrow) must implement. Defined by what the agents + bootstrapSchema
// actually consume from the existing McpClient surface — so adapters can swap
// in without any caller (agent, route handler, bootstrap helper) caring which
// concrete protocol is on the other side.
//
// The {result, durationMs, fromCache} envelope mirrors McpClient's return shape
// exactly so the rename does not change behavior — adapters that don't track
// duration or cache hits return fromCache=false and a real or 0 durationMs.

/** A single tool exposed by a data source. Mirrors the MCP `Tool` shape but is
 *  protocol-agnostic so SQL-backed (or any other) adapters can describe their
 *  tools to the model without leaking MCP-specific fields. */
export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** Result envelope from a tool call. Matches the MCP `CallToolResult` shape for
 *  cross-adapter compatibility — `isError` lets the loop's tool_result block
 *  carry the `is_error: true` flag back to the model, and `content` / arbitrary
 *  structuredContent fields ride through `unwrap()` in lib/mcp/schema.ts. */
export interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  // Adapters MAY include additional fields (e.g. `structuredContent`) — kept
  // open since the unwrap helper prefers structuredContent over content[].
  [key: string]: unknown;
}

/** Per-call options the DataSource accepts from callers. Today only `signal`
 *  is in the abstract surface — adapter-specific options (skipCache, cacheTtlMs)
 *  live on the concrete BloomreachDataSource class, since the agent layer never
 *  needs them. */
export interface DataSourceCallOptions {
  signal?: AbortSignal;
}

export interface DataSourceListOptions {
  signal?: AbortSignal;
}

/** The {result, durationMs, fromCache} envelope every DataSource returns from a
 *  tool call. The agent loop reads `result` and `durationMs`; `fromCache` is
 *  surfaced in tool-call traces for the UI's "how this was gathered" panel.
 *  `result` stays `unknown` (not generic) to match the existing McpClient
 *  return type exactly — call sites cast as needed (e.g. `unwrap<T>(result)`
 *  in lib/mcp/schema.ts). */
export interface DataSourceCallResult {
  result: unknown;
  durationMs: number;
  fromCache: boolean;
}

/** Abstract surface every data source must implement. Adapters in this repo:
 *    - BloomreachDataSource — the live MCP client over Bloomreach Engagement
 *    - OlistDataSource      — coming in PR B, MCP server over SQLite/Olist
 *
 *  Agents (monitoring, diagnostic, recommendation, query) hold a DataSource
 *  reference, never a concrete adapter. */
export interface DataSource {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult>;

  listTools(opts?: DataSourceListOptions): Promise<unknown>;
}
