// mcp-server-olist/src/server.ts
//
// MCP server entry point — wires the three domain tools onto an MCP
// Server + StdioServerTransport. The server is meant to be spawned as a
// subprocess by lib/data-source/olist-data-source.ts; running it stand-alone is
// useful only for manual debugging / inspection.
//
// Error contract: every tool handler returns its result via the MCP envelope
//   { content: [{ type: 'text', text: <JSON> }], isError?: boolean }
// We NEVER throw out of a handler — invalid input + DB errors become
// `isError: true` envelopes so the client (and our OlistDataSource adapter)
// can report them through the same path as a successful result.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';

import { openDb } from './db.js';
import {
  getMetricTimeseriesSchema,
  getSegmentsSchema,
  getAnomalyContextSchema,
} from './schemas.js';
import * as getMetricTimeseries from './tools/get_metric_timeseries.js';
import * as getSegments from './tools/get_segments.js';
import * as getAnomalyContext from './tools/get_anomaly_context.js';

export const TOOL_DEFINITIONS = [
  {
    name: 'get_metric_timeseries',
    description:
      'Aggregate a metric (revenue, order_count, avg_order_value, payment_value) over a time window. Optionally group by a dimension (state/category/payment_type) and/or filter by a single dimension/value pair. Use this as the primary "what changed?" query.',
    inputSchema: getMetricTimeseriesSchema as Record<string, unknown>,
  },
  {
    name: 'get_segments',
    description:
      'List the distinct values of a dimension (e.g. all Brazilian states, all product categories, all payment types) with order_count + revenue in the requested window. Use this to discover what to filter on before drilling in with get_metric_timeseries.',
    inputSchema: getSegmentsSchema as Record<string, unknown>,
  },
  {
    name: 'get_anomaly_context',
    description:
      'For a flagged anomaly (metric + dimension + segment + anomaly_window vs baseline_window), return a summary (anomaly_value, baseline_avg, pct_change), how other segments in the same dimension moved (related_segments), and up to 10 representative orders from the anomaly window. Use this for diagnostic evidence-gathering.',
    inputSchema: getAnomalyContextSchema as Record<string, unknown>,
  },
] as const;

/** Wrap an unknown thrown error into an MCP-spec isError envelope. */
function errorEnvelope(message: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Wrap a JSON-serializable result into an MCP success envelope. The result is
 *  stringified into a single text block (matches the shape blooming insights'
 *  `unwrap()` helper already expects — it prefers structuredContent, falls back
 *  to content[0].text). We also include structuredContent for clients that
 *  prefer the typed form. */
function successEnvelope(result: unknown): {
  content: Array<{ type: string; text: string }>;
  structuredContent: { data: unknown };
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: { data: result },
  };
}

/** Dispatch a CallToolRequest to the right tool handler. Pure function over
 *  (db, name, args) — exported so server.test.ts can exercise it without
 *  spinning up stdio. */
export function callTool(
  db: Database.Database,
  name: string,
  args: unknown,
): ReturnType<typeof successEnvelope> | ReturnType<typeof errorEnvelope> {
  try {
    switch (name) {
      case 'get_metric_timeseries': {
        const validated = getMetricTimeseries.validateInput(args);
        if (typeof validated === 'string') return errorEnvelope(`invalid input: ${validated}`);
        return successEnvelope(getMetricTimeseries.execute(db, validated));
      }
      case 'get_segments': {
        const validated = getSegments.validateInput(args);
        if (typeof validated === 'string') return errorEnvelope(`invalid input: ${validated}`);
        return successEnvelope(getSegments.execute(db, validated));
      }
      case 'get_anomaly_context': {
        const validated = getAnomalyContext.validateInput(args);
        if (typeof validated === 'string') return errorEnvelope(`invalid input: ${validated}`);
        return successEnvelope(getAnomalyContext.execute(db, validated));
      }
      default:
        return errorEnvelope(`unknown tool: ${name}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorEnvelope(`tool error: ${msg}`);
  }
}

/** Build (but do not connect) an MCP Server with our tool handlers wired up.
 *  Separated from connection so tests can exercise the registration without
 *  going through stdio. */
export function buildServer(db: Database.Database): Server {
  const server = new Server(
    { name: 'mcp-server-olist', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return callTool(db, name, args ?? {});
  });

  return server;
}

/** Open the DB, wire the server, connect to stdio. The function returns after
 *  connect() so callers (tests, the index.ts entry) can await readiness. */
export async function startServer(): Promise<{ server: Server; db: Database.Database }> {
  const db = openDb();
  const server = buildServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, db };
}
