// eval/scripts/lib/run-intent-agent.ts
//
// One-shot driver for `classifyIntent()` — the intent classifier is a single
// Anthropic call (Haiku) with no DataSource dependency, so this driver is
// thinner than the other run-* drivers.
//
// Used by PR G's regression eval: a fixed query string in / a captured Intent
// label out. Used for the 10-intent-classify-investigation fixture.

import Anthropic from '@anthropic-ai/sdk';
import { classifyIntent, type Intent } from '../../../lib/agents/intent';

/** What one intent run captures for regression comparison. */
export interface IntentRunCapture {
  /** Sequential index within a multi-run series (always 1 for regression). */
  runIndex: number;
  /** Wall-clock from the start of the call to its return. */
  durationMs: number;
  /** The query string handed to classifyIntent() — captured for audit/replay. */
  inputQuery: string;
  /** The Intent label the classifier returned; null if the run errored. */
  intent: Intent | null;
  /** Populated when the run threw; otherwise undefined. */
  error?: string;
}

/**
 * Run `classifyIntent()` once. NEVER throws — failures are returned as
 * `capture.error` so the regression driver can mark the fixture errored
 * and keep going.
 *
 * No OlistDataSource is constructed here: the intent classifier is pure
 * Anthropic + a free-form query string (per lib/agents/intent.ts), and
 * the production code path (app/api/agent/route.ts) calls it before
 * deciding whether to route to QueryAgent vs the investigation agents.
 */
export async function runIntentAgentOnce(
  runIndex: number,
  inputQuery: string,
  sessionId: string,
): Promise<IntentRunCapture> {
  const start = Date.now();
  let intent: Intent | null = null;
  let error: string | undefined;

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    intent = await classifyIntent(anthropic, inputQuery, sessionId);
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  return {
    runIndex,
    durationMs: Date.now() - start,
    inputQuery,
    intent,
    error,
  };
}
