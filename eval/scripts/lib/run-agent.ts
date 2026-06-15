// eval/scripts/lib/run-agent.ts
//
// One-shot driver: spin up the same MonitoringAgent the briefing route uses,
// running against the live OlistDataSource (subprocess + SQLite), and capture
// the emitted anomalies + tool calls + reasoning into a struct (no streaming).
//
// Mirrors app/api/briefing/route.ts's wiring exactly — same factory call shape,
// same hook surface, same workspace schema — but without the NDJSON stream and
// without the per-mode branching (we hardcode 'live-sql' here because eval only
// scores the Olist path).
//
// The function takes ownership of the DataSource lifecycle: it constructs one
// fresh per call, connects, runs the agent, and disposes the subprocess. That
// keeps each eval run isolated from the others — if one MCP subprocess crashes
// the next run gets a clean spawn.

import Anthropic from '@anthropic-ai/sdk';
import { OlistDataSource } from '../../../lib/data-source/olist-data-source';
import { olistWorkspaceSchema } from '../../../lib/mcp/schema';
import { MonitoringAgent } from '../../../lib/agents/monitoring';
import { schemaCapabilities, runnableCategories } from '../../../lib/agents/categories';
import type { McpToolDef } from '../../../lib/agents/tool-schemas';
import type { Anomaly, ToolCall } from '../../../lib/mcp/types';

/** What one eval run captures from the monitoring agent. Shape stays flat so
 *  the JSON files written to disk are auditable line-by-line. */
export interface AgentRunCapture {
  /** Sequential index within the K-run series. */
  runIndex: number;
  /** Wall-clock from connect() through dispose(). */
  durationMs: number;
  /** Anomalies the agent emitted (already sorted by severity). */
  insights: Anomaly[];
  /** Every tool call made during the scan, in order. Useful for diagnosing
   *  why a run missed an anomaly — did it never query the relevant segment? */
  toolCalls: ToolCall[];
  /** Free-text reasoning blocks the agent surfaced through `onText`. Stored
   *  for human audit; not used by the scorer. */
  reasoning: string[];
  /** Populated when the run threw; otherwise undefined. Lets the eval driver
   *  log + continue rather than aborting the whole K-run series. */
  error?: string;
}

/**
 * Run MonitoringAgent.scan() once against the live OlistDataSource and
 * capture everything for scoring. NEVER throws — failures are returned as
 * `capture.error` so the eval driver can mark the run as errored and keep
 * going with run i+1.
 */
export async function runMonitoringAgentOnce(
  runIndex: number,
  sessionId: string,
): Promise<AgentRunCapture> {
  const start = Date.now();
  const dataSource = new OlistDataSource();
  const reasoning: string[] = [];
  let insights: Anomaly[] = [];
  let toolCalls: ToolCall[] = [];
  let error: string | undefined;

  try {
    await dataSource.connect();

    // The Olist bootstrap is synthesized (no schema-discovery tools on the
    // Olist server) — same call the makeDataSource('live-sql') factory makes.
    const schema = olistWorkspaceSchema();

    // listTools so the agent gets the actual JSON Schemas the Olist server
    // advertises (same path the route takes).
    const raw = await dataSource.listTools();
    const allTools: McpToolDef[] = Array.isArray((raw as { tools?: unknown })?.tools)
      ? (raw as { tools: McpToolDef[] }).tools
      : [];

    // The Olist schema's `events` (order/payment/review) won't match any of
    // the 10 hardcoded ecommerce categories' `requires` lists (view_item,
    // checkout, purchase, etc.), so runnable will be []. The monitoring agent
    // is built to handle that — its prompt has an Olist-specific fallback
    // branch that scans revenue / order_count / payment_value by state /
    // category / payment_type. Eval scores THAT fallback path, which is the
    // path the production route actually uses on Olist.
    const capabilities = schemaCapabilities(schema);
    const runnable = runnableCategories(capabilities);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const agent = new MonitoringAgent(anthropic, dataSource, schema, allTools, sessionId);

    insights = await agent.scan(
      {
        onToolCall: (tc) => {
          toolCalls.push(tc);
        },
        onToolResult: (tc) => {
          // overwrite the in-array entry with the now-result-bearing copy
          // (same object identity, but onToolCall fires before result lands).
          const idx = toolCalls.findIndex((c) => c.id === tc.id);
          if (idx >= 0) toolCalls[idx] = tc;
        },
        onText: (t) => {
          const trimmed = t.trim();
          if (trimmed) reasoning.push(trimmed);
        },
      },
      runnable,
    );
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } finally {
    try {
      await dataSource.dispose();
    } catch {
      // best-effort; the subprocess is already going down regardless
    }
  }

  return {
    runIndex,
    durationMs: Date.now() - start,
    insights,
    toolCalls,
    reasoning,
    error,
  };
}
