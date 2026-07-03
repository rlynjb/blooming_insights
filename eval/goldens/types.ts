// eval/goldens/types.ts
//
// Shared type for a golden case. Each golden file exports one `GoldenCase`
// and eval/goldens/index.ts collects them into the array that run.eval.ts
// iterates over with `it.each()`.
//
// `signalClass` documents whether the SyntheticDataSource substrate can
// actually support the anomaly. `no-signal` cases test the agent's
// hallucination resistance — it should say "insufficient evidence"
// rather than confabulate.

import type { Anomaly } from '../../lib/mcp/types';

export type SignalClass =
  | 'has-signal'      // substrate returns data that supports diagnosis
  | 'partial-signal'  // substrate has some relevant data but not the full picture
  | 'no-signal'       // substrate has no data — agent should refuse
  | 'positive';       // a positive/upward anomaly (rare in training, worth testing)

export interface GoldenCase {
  caseId: string;
  signalClass: SignalClass;
  /**
   * Free-form human-readable note explaining what the case tests.
   * Included in the receipt for the human reviewing results.
   */
  intent: string;
  anomaly: Anomaly;
  /**
   * "Known correct shape" notes — passed as `known_correct_shape` context to
   * the diagnosis judge. Structure varies per case; the judge reads it as
   * free-form guidance about what the diagnosis SHOULD reflect.
   *
   * For `no-signal` cases, this should describe what the agent CANNOT
   * conclude (and what shape "insufficient evidence" would take).
   */
  knownCorrect: Record<string, unknown>;
}
