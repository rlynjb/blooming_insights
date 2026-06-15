// eval/scripts/lib/run-query-agent.ts
//
// One-shot driver for `QueryAgent.answer()` — mirrors run-diagnostic-agent.ts
// and run-recommendation-agent.ts but invokes the query agent on a free-form
// natural-language query.
//
// Used by PR G's regression eval: a fixed query string in / a captured answer
// out. Each call spins up a fresh OlistDataSource subprocess and tears it down
// on completion (per-run isolation matches the other drivers).
//
// Note: QueryAgent.answer() takes an `intent` argument that is normally produced
// upstream by `classifyIntent()`. For the regression eval we pass the intent in
// directly via the fixture so the run is deterministic against the input alone
// (the classifier's stochasticity is exercised by a separate intent fixture).

import Anthropic from '@anthropic-ai/sdk';
import { OlistDataSource } from '../../../lib/data-source/olist-data-source';
import { olistWorkspaceSchema } from '../../../lib/mcp/schema';
import { QueryAgent } from '../../../lib/agents/query';
import type { McpToolDef } from '../../../lib/agents/tool-schemas';
import type { Intent } from '../../../lib/agents/intent';
import type { ToolCall } from '../../../lib/mcp/types';

/** What one query run captures for regression comparison. */
export interface QueryRunCapture {
  /** Sequential index within a multi-run series (always 1 for regression). */
  runIndex: number;
  /** Wall-clock from connect() through dispose(). */
  durationMs: number;
  /** The query string handed to answer() — captured for audit/replay. */
  inputQuery: string;
  /** The intent passed in (fixture-specified so the run is deterministic). */
  inputIntent: Intent;
  /** Final answer text the agent produced; empty string if errored. */
  answer: string;
  /** Every tool call the agent made, in order. The regression judge reads
   *  the structural shape, not the transcript — but it's kept for audit. */
  toolCalls: ToolCall[];
  /** Free-text reasoning blocks via `onText`. Stored for human audit. */
  reasoning: string[];
  /** Populated when the run threw; otherwise undefined. */
  error?: string;
}

/**
 * Run `QueryAgent.answer()` once against the live OlistDataSource. NEVER throws —
 * failures are returned as `capture.error` so the regression driver can mark
 * the fixture errored and keep going.
 */
export async function runQueryAgentOnce(
  runIndex: number,
  inputQuery: string,
  inputIntent: Intent,
  sessionId: string,
): Promise<QueryRunCapture> {
  const start = Date.now();
  const dataSource = new OlistDataSource();
  const reasoning: string[] = [];
  const toolCalls: ToolCall[] = [];
  let answer = '';
  let error: string | undefined;

  try {
    await dataSource.connect();

    // Synthesized Olist schema (same factory call the /api/agent route makes
    // for live-sql mode).
    const schema = olistWorkspaceSchema();

    // listTools so the query agent sees the same JSON Schemas the Olist server
    // advertises (same path the production route takes).
    const raw = await dataSource.listTools();
    const allTools: McpToolDef[] = Array.isArray((raw as { tools?: unknown })?.tools)
      ? (raw as { tools: McpToolDef[] }).tools
      : [];

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const agent = new QueryAgent(anthropic, dataSource, schema, allTools, sessionId);

    answer = await agent.answer(inputQuery, inputIntent, {
      onToolCall: (tc) => {
        toolCalls.push(tc);
      },
      onToolResult: (tc) => {
        const idx = toolCalls.findIndex((c) => c.id === tc.id);
        if (idx >= 0) toolCalls[idx] = tc;
      },
      onText: (t) => {
        const trimmed = t.trim();
        if (trimmed) reasoning.push(trimmed);
      },
    });
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } finally {
    try {
      await dataSource.dispose();
    } catch {
      // best-effort
    }
  }

  return {
    runIndex,
    durationMs: Date.now() - start,
    inputQuery,
    inputIntent,
    answer,
    toolCalls,
    reasoning,
    error,
  };
}
