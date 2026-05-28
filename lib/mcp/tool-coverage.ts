// Cross-check the tool names this codebase configures against the tool set the
// connected MCP server actually exposes. A configured-but-nonexistent name is a
// silent budget burner: the agent can pick it, the call fails, and a scarce
// rate-limited slot is wasted. Pure functions here are unit-tested; the live
// names are supplied by GET /api/mcp/tools/check.

import {
  monitoringTools,
  diagnosticTools,
  recommendationTools,
  bootstrapTools,
} from './tools';

export interface ToolCoverageReport {
  /** Tool names the server exposes, sorted. */
  serverTools: string[];
  /** Configured names absent from the server, per list. Each should be empty. */
  missing: {
    monitoring: string[];
    diagnostic: string[];
    recommendation: string[];
    bootstrap: string[];
  };
  /** True when no configured name is missing from the server. */
  ok: boolean;
  /** Server tools no configured list references (informational, not a failure). */
  unusedOnServer: string[];
}

/** Extract tool names from a raw `listTools()` envelope: `{ tools: [{ name }] }`. */
export function extractToolNames(listToolsResult: unknown): string[] {
  const tools = (listToolsResult as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (t as { name?: unknown })?.name)
    .filter((n): n is string => typeof n === 'string');
}

export function crossCheckToolCoverage(serverToolNames: string[]): ToolCoverageReport {
  const server = new Set(serverToolNames);
  const absent = (list: readonly string[]) => list.filter((n) => !server.has(n));

  const missing = {
    monitoring: absent(monitoringTools),
    diagnostic: absent(diagnosticTools),
    recommendation: absent(recommendationTools),
    bootstrap: absent(bootstrapTools),
  };

  const configured = new Set<string>([
    ...monitoringTools,
    ...diagnosticTools,
    ...recommendationTools,
    ...bootstrapTools,
  ]);

  return {
    serverTools: [...server].sort(),
    missing,
    ok: Object.values(missing).every((list) => list.length === 0),
    unusedOnServer: serverToolNames.filter((n) => !configured.has(n)).sort(),
  };
}
