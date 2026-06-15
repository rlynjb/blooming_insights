// eval/scripts/lib/judge-rec.ts
//
// LLM-as-judge harness for PR F (recommendation rubric). Sibling to judge.ts;
// kept separate because the rubric is a different shape (3 criteria, max 5,
// pass >= 4) and a single polymorphic Judge<Output> would have leaked rubric
// detail into shared types without payoff. Same retry policy, same JSON
// parsing strategy, same model.
//
// One call per candidate recommendation set: read judge prompt, send anomaly
// + input diagnosis + reference + candidate, parse the JSON verdict.

import Anthropic from '@anthropic-ai/sdk';
import type { Diagnosis, Recommendation } from '../../../lib/mcp/types';
import type { SeededAnomaly } from './scorer';

/** One reference recommendation set from
 *  eval/fixtures/reference-recommendations.json. */
export type ReferenceRecommendations = Array<Omit<Recommendation, 'id'>>;

/** Shape passed to the judge. Serialized as JSON in the user message so the
 *  judge sees structured inputs (cleaner than freeform prose). */
export interface RecJudgeInput {
  anomaly_metadata: SeededAnomaly;
  input_diagnosis: Diagnosis;
  reference_recommendations: ReferenceRecommendations;
  candidate_recommendations: Recommendation[];
}

/** Strict scoring output. Matches the format the judge prompt asks for. */
export interface RecJudgeScores {
  plausible: number;    // 0-2
  specific: number;     // 0-2
  impact_sized: number; // 0-1
}

export interface RecJudgeOutput {
  scores: RecJudgeScores;
  total: number;         // 0-5
  pass: boolean;         // total >= 4
  reasoning_per_criterion: Record<string, string>;
  /** Raw model output (for audit / debugging unparsed responses). */
  raw_response: string;
  /** Number of attempts the judge needed (1 = clean parse, 2 = retried once). */
  attempts: number;
}

export interface RecJudgeError {
  judge_error: string;
  raw_response: string;
  attempts: number;
}

/** Judge model — kept in sync with PR E's diagnosis judge (Phase 3 plan Q1:
 *  same model for working / eval / judge). */
export const REC_JUDGE_MODEL = 'claude-sonnet-4-6';

/** Parse a judge response. Allows the model to wrap in ```json fences or just
 *  emit raw JSON — both are common in Sonnet's outputs. Mirrors the diagnosis
 *  judge's tolerance for stray paragraphs. */
function tryParseRecJudgeJson(raw: string): RecJudgeOutput | null {
  let text = raw.trim();

  // Strip a ```json … ``` fence if present.
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Find the first '{' and last '}' to slice.
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

  const plausible = num(scores.plausible);
  const specific = num(scores.specific);
  const impactSized = num(scores.impact_sized);

  if (plausible == null || specific == null || impactSized == null) {
    return null;
  }

  // Clamp to valid ranges so one wild output doesn't lose the whole row.
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const finalScores: RecJudgeScores = {
    plausible: clamp(plausible, 0, 2),
    specific: clamp(specific, 0, 2),
    impact_sized: clamp(impactSized, 0, 1),
  };

  const total = finalScores.plausible + finalScores.specific + finalScores.impact_sized;

  const reasoning = (obj.reasoning_per_criterion ?? {}) as Record<string, string>;

  return {
    scores: finalScores,
    total,
    pass: total >= 4,
    reasoning_per_criterion: reasoning,
    raw_response: raw,
    attempts: 1, // overwritten by caller on retry
  };
}

/**
 * Send the judge prompt + inputs to Anthropic; parse + return the verdict.
 * On malformed JSON, retries ONCE with a stricter "JSON only" reminder.
 * If both attempts fail, returns a RecJudgeError tagged with the raw response.
 */
export async function judgeRecommendations(
  anthropic: Anthropic,
  input: RecJudgeInput,
  judgePromptText: string,
): Promise<RecJudgeOutput | RecJudgeError> {
  const userMessage = JSON.stringify(
    {
      anomaly_metadata: input.anomaly_metadata,
      input_diagnosis: input.input_diagnosis,
      reference_recommendations: input.reference_recommendations,
      candidate_recommendations: input.candidate_recommendations,
    },
    null,
    2,
  );

  const callJudge = async (extraInstruction?: string): Promise<string> => {
    const res = await anthropic.messages.create({
      model: REC_JUDGE_MODEL,
      max_tokens: 1500,
      system: judgePromptText,
      messages: [
        {
          role: 'user',
          content:
            (extraInstruction ? `${extraInstruction}\n\n` : '') +
            `Score the candidate recommendations below. Return JSON only — no prose, no fences.\n\n${userMessage}`,
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
  const parsed1 = tryParseRecJudgeJson(raw1);
  if (parsed1) {
    return { ...parsed1, attempts: 1, raw_response: raw1 };
  }

  // Attempt 2 — stricter framing.
  const raw2 = await callJudge(
    'Your previous response was not valid JSON. Return ONLY the JSON object — no markdown, no prose, no fences. Begin with "{" and end with "}".',
  );
  const parsed2 = tryParseRecJudgeJson(raw2);
  if (parsed2) {
    return { ...parsed2, attempts: 2, raw_response: raw2 };
  }

  return {
    judge_error: 'Judge returned malformed JSON on both attempts.',
    raw_response: raw2,
    attempts: 2,
  };
}

/** Helper for the eval driver: construct the RecJudgeInput from raw pieces. */
export function buildRecJudgeInput(
  anomalyMetadata: SeededAnomaly,
  inputDiagnosis: Diagnosis,
  referenceRecommendations: ReferenceRecommendations,
  candidateRecommendations: Recommendation[],
): RecJudgeInput {
  return {
    anomaly_metadata: anomalyMetadata,
    input_diagnosis: inputDiagnosis,
    reference_recommendations: referenceRecommendations,
    candidate_recommendations: candidateRecommendations,
  };
}

/** Narrowing helper for callers. */
export function isRecJudgeError(v: RecJudgeOutput | RecJudgeError): v is RecJudgeError {
  return 'judge_error' in v;
}
