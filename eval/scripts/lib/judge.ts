// eval/scripts/lib/judge.ts
//
// LLM-as-judge harness for PR E (diagnosis rubric). One call per candidate
// diagnosis: read judge prompt, send anomaly + reference + candidate + tool
// transcript, parse the JSON verdict.
//
// Anti-bias measures inherited from the judge prompt: criterion scoring,
// few-shot anchors, JSON-only output. This file's job is JUST to call the
// model and parse the result robustly.
//
// Error handling: judge calls are unreliable enough that we retry ONCE on a
// malformed JSON response. After that we mark the run as `judge_error` and
// move on — the eval driver counts errored judge runs separately so they
// don't silently corrupt the aggregate.

import Anthropic from '@anthropic-ai/sdk';
import type { Diagnosis, ToolCall } from '../../../lib/mcp/types';
import type { SeededAnomaly } from './scorer';

/** One reference diagnosis from eval/fixtures/reference-diagnoses.json. */
export interface ReferenceDiagnosis {
  anomaly_summary: string;
  ground_truth_multiplier: number;
  ground_truth_pct_change: string;
  investigation_should_examine: string[];
  expected_evidence_tools: string[];
  key_evidence_signals?: string[];
}

/** Shape passed to the judge. Serialized as JSON in the user message so the
 *  judge sees structured inputs (cleaner than freeform prose). */
export interface JudgeInput {
  anomaly_metadata: SeededAnomaly;
  reference_diagnosis: ReferenceDiagnosis;
  candidate_diagnosis: Diagnosis;
  tool_call_transcript: Array<{
    toolName: string;
    args: Record<string, unknown>;
    result?: unknown;
    error?: string;
  }>;
}

/** Strict scoring output. Matches the format the judge prompt asks for. */
export interface JudgeScores {
  hypothesis: number;  // 0-2
  evidence: number;    // 0-2
  sizing: number;      // 0-2
  calibration: number; // 0-1
  fabrication: number; // 0-2
}

export interface JudgeOutput {
  scores: JudgeScores;
  total: number;         // 0-9
  pass: boolean;         // total >= 7
  reasoning_per_criterion: Record<string, string>;
  /** Raw model output (for audit / debugging unparsed responses). */
  raw_response: string;
  /** Number of attempts the judge needed (1 = clean parse, 2 = retried once). */
  attempts: number;
}

export interface JudgeError {
  judge_error: string;
  raw_response: string;
  attempts: number;
}

/** Judge model — kept in sync with AGENT_MODEL by convention (per Phase 3 plan
 *  resolved Q1: same model for working / eval / judge for now). */
export const JUDGE_MODEL = 'claude-sonnet-4-6';

/** Truncate large tool results so the judge sees the signal without the noise.
 *  Olist tools occasionally return ~50KB of sample_orders; the judge doesn't
 *  need the full row dump to score whether the candidate's claims are grounded. */
const TOOL_RESULT_TRUNCATE = 4000;

function truncateResult(value: unknown): unknown {
  if (value == null) return value;
  const s = JSON.stringify(value);
  if (s.length <= TOOL_RESULT_TRUNCATE) return value;
  return s.slice(0, TOOL_RESULT_TRUNCATE) + '…[truncated]';
}

/** Strip the `_meta` block and unrelated transport noise from the tool result
 *  before handing to the judge. We DO keep error strings — the judge needs to
 *  know if a citation references a call that errored. */
function prepareTranscript(toolCalls: ToolCall[]): JudgeInput['tool_call_transcript'] {
  return toolCalls.map((tc) => ({
    toolName: tc.toolName,
    args: tc.args,
    result: tc.error ? undefined : truncateResult(tc.result),
    error: tc.error,
  }));
}

/** Parse a judge response. Allows the model to wrap in ```json fences or just
 *  emit raw JSON — both are common in Sonnet's outputs. Strips leading/trailing
 *  prose if the model couldn't help itself. */
function tryParseJudgeJson(raw: string): JudgeOutput | null {
  let text = raw.trim();

  // Strip a ```json … ``` fence if present.
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Find the first '{' and last '}' to slice — handles a stray paragraph
  // before or after the JSON.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null;
  const slice = text.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const scores = obj.scores as Record<string, unknown> | undefined;
  if (!scores || typeof scores !== 'object') return null;

  const num = (v: unknown): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return Math.round(v);
  };

  const hypothesis = num(scores.hypothesis);
  const evidence = num(scores.evidence);
  const sizing = num(scores.sizing);
  const calibration = num(scores.calibration);
  const fabrication = num(scores.fabrication);

  if (
    hypothesis == null ||
    evidence == null ||
    sizing == null ||
    calibration == null ||
    fabrication == null
  ) {
    return null;
  }

  // Clamp to valid ranges. A judge that scores hypothesis=3 is misbehaving;
  // we clamp instead of failing so one wild output doesn't lose the whole row.
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const finalScores: JudgeScores = {
    hypothesis: clamp(hypothesis, 0, 2),
    evidence: clamp(evidence, 0, 2),
    sizing: clamp(sizing, 0, 2),
    calibration: clamp(calibration, 0, 1),
    fabrication: clamp(fabrication, 0, 2),
  };

  const total =
    finalScores.hypothesis +
    finalScores.evidence +
    finalScores.sizing +
    finalScores.calibration +
    finalScores.fabrication;

  const reasoning = (obj.reasoning_per_criterion ?? {}) as Record<string, string>;

  return {
    scores: finalScores,
    total,
    pass: total >= 7,
    reasoning_per_criterion: reasoning,
    raw_response: raw,
    attempts: 1, // overwritten by caller on retry
  };
}

/**
 * Send the judge prompt + inputs to Anthropic; parse + return the verdict.
 * On malformed JSON, retries ONCE with a stricter "JSON only" reminder.
 * If both attempts fail, returns a JudgeError tagged with the raw response.
 */
export async function judgeDiagnosis(
  anthropic: Anthropic,
  input: JudgeInput,
  judgePromptText: string,
): Promise<JudgeOutput | JudgeError> {
  const userMessage = JSON.stringify(
    {
      anomaly_metadata: input.anomaly_metadata,
      reference_diagnosis: input.reference_diagnosis,
      candidate_diagnosis: input.candidate_diagnosis,
      tool_call_transcript: input.tool_call_transcript,
    },
    null,
    2,
  );

  const callJudge = async (extraInstruction?: string): Promise<string> => {
    const res = await anthropic.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 1500,
      system: judgePromptText,
      messages: [
        {
          role: 'user',
          content:
            (extraInstruction ? `${extraInstruction}\n\n` : '') +
            `Score the candidate diagnosis below. Return JSON only — no prose, no fences.\n\n${userMessage}`,
        },
      ],
    });
    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return text;
  };

  // Attempt 1
  const raw1 = await callJudge();
  const parsed1 = tryParseJudgeJson(raw1);
  if (parsed1) {
    return { ...parsed1, attempts: 1, raw_response: raw1 };
  }

  // Attempt 2 — stricter framing.
  const raw2 = await callJudge(
    'Your previous response was not valid JSON. Return ONLY the JSON object — no markdown, no prose, no fences. Begin with "{" and end with "}".',
  );
  const parsed2 = tryParseJudgeJson(raw2);
  if (parsed2) {
    return { ...parsed2, attempts: 2, raw_response: raw2 };
  }

  return {
    judge_error: 'Judge returned malformed JSON on both attempts.',
    raw_response: raw2,
    attempts: 2,
  };
}

/** Helper for the eval driver: construct the JudgeInput from raw run pieces. */
export function buildJudgeInput(
  anomalyMetadata: SeededAnomaly,
  referenceDiagnosis: ReferenceDiagnosis,
  candidateDiagnosis: Diagnosis,
  toolCalls: ToolCall[],
): JudgeInput {
  return {
    anomaly_metadata: anomalyMetadata,
    reference_diagnosis: referenceDiagnosis,
    candidate_diagnosis: candidateDiagnosis,
    tool_call_transcript: prepareTranscript(toolCalls),
  };
}

/** Narrowing helper for callers. */
export function isJudgeError(v: JudgeOutput | JudgeError): v is JudgeError {
  return 'judge_error' in v;
}
