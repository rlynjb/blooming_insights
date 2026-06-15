// eval/scripts/lib/run-diagnostic-agent.ts
//
// One-shot driver for `DiagnosticAgent.investigate()` — mirrors run-agent.ts
// (the monitoring driver) but invokes the diagnostic agent directly on a
// pre-built Anomaly object instead of running upstream detection.
//
// Path-C bypass per PR D's analysis: this isolates diagnosis quality from
// the detection pipeline's coverage gap. The seeded anomaly metadata is
// converted to an Anomaly via seededToAnomaly() and handed directly to the
// diagnostic agent — same constructor + investigate() shape the production
// /api/agent route uses.
//
// Each call spins up a fresh OlistDataSource subprocess + tears it down on
// completion. Per-run isolation matches run-agent.ts so one crashed run can't
// poison the next.

import Anthropic from '@anthropic-ai/sdk';
import { OlistDataSource } from '../../../lib/data-source/olist-data-source';
import { olistWorkspaceSchema } from '../../../lib/mcp/schema';
import { DiagnosticAgent } from '../../../lib/agents/diagnostic';
import type { McpToolDef } from '../../../lib/agents/tool-schemas';
import type { Anomaly, Diagnosis, ToolCall } from '../../../lib/mcp/types';

/** What one diagnostic run captures for the judge. */
export interface DiagnosticRunCapture {
  /** Sequential index within the K-run series for this anomaly. */
  runIndex: number;
  /** Which seeded anomaly id this run was for (e.g. 'sp-revenue-drop-w4'). */
  anomalyId: string;
  /** Wall-clock from connect() through dispose(). */
  durationMs: number;
  /** The Anomaly object handed to investigate() — captured for audit/replay. */
  inputAnomaly: Anomaly;
  /** The diagnosis the agent produced; null if the run errored. */
  diagnosis: Diagnosis | null;
  /** Every tool call made during the investigation, in order. The judge reads
   *  this to verify the diagnosis's claims trace back to real tool results. */
  toolCalls: ToolCall[];
  /** Free-text reasoning blocks the agent surfaced via `onText`. Stored for
   *  human audit; not consumed by the judge directly (the judge scores the
   *  structured diagnosis object). */
  reasoning: string[];
  /** Populated when the run threw; otherwise undefined. */
  error?: string;
}

/**
 * Run `DiagnosticAgent.investigate()` once against the live OlistDataSource.
 * NEVER throws — failures are returned as `capture.error` so the eval driver
 * can mark the run errored and continue with run i+1.
 */
export async function runDiagnosticAgentOnce(
  runIndex: number,
  anomalyId: string,
  inputAnomaly: Anomaly,
  sessionId: string,
): Promise<DiagnosticRunCapture> {
  const start = Date.now();
  const dataSource = new OlistDataSource();
  const reasoning: string[] = [];
  const toolCalls: ToolCall[] = [];
  let diagnosis: Diagnosis | null = null;
  let error: string | undefined;

  try {
    await dataSource.connect();

    // Synthesized Olist schema (same factory call the /api/agent route makes
    // for live-sql mode).
    const schema = olistWorkspaceSchema();

    // listTools so the diagnostic agent sees the same JSON Schemas the Olist
    // server advertises (same path the production route takes).
    const raw = await dataSource.listTools();
    const allTools: McpToolDef[] = Array.isArray((raw as { tools?: unknown })?.tools)
      ? (raw as { tools: McpToolDef[] }).tools
      : [];

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const agent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sessionId);

    diagnosis = await agent.investigate(inputAnomaly, {
      onToolCall: (tc) => {
        toolCalls.push(tc);
      },
      onToolResult: (tc) => {
        // overwrite the in-array entry with the now-result-bearing copy
        // (same object identity, but onToolCall fires before the result lands).
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
    anomalyId,
    durationMs: Date.now() - start,
    inputAnomaly,
    diagnosis,
    toolCalls,
    reasoning,
    error,
  };
}
