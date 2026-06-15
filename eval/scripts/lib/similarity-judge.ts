// eval/scripts/lib/similarity-judge.ts
//
// LLM-as-judge harness for PR G (regression eval). One call per fixture: read
// the similarity-judge prompt, send the fixture input + golden output + new
// output, parse a JSON verdict {same_conclusion, confidence, notes,
// differences_named}.
//
// Sibling to judge.ts (diagnosis rubric) and judge-rec.ts (recommendation
// rubric) — same retry policy, same JSON parsing strategy, same model. Kept
// separate because the output shape is different (similarity is a yes/no with
// confidence, not a criterion-scored total).
//
// The judge here is doing SIMILARITY scoring, not quality scoring. "Does the
// new output convey the same conclusion as the golden, allowing for minor
// wording shifts from LLM sampling?" The rubric in eval/judges/similarity-
// judge.md describes the line between allowable rewording and a real
// regression.

import Anthropic from '@anthropic-ai/sdk';

/** Shape passed to the similarity judge. Serialized as JSON in the user
 *  message so the judge sees structured inputs (cleaner than freeform prose). */
export interface SimilarityJudgeInput {
  /** Which fixture this verdict is for. Used by the judge to anchor its
   *  notes ("for fixture 02-monitoring-3-anomalies, the new output…"). */
  fixture_id: string;
  /** Which agent the fixture exercises — gives the judge context for what
   *  "same conclusion" means in this domain (a monitoring run "concludes"
   *  via emitted anomalies; a query "concludes" via a prose answer). */
  agent: string;
  /** The originally captured output. */
  golden_output: unknown;
  /** The output to compare. */
  new_output: unknown;
  /** What the agent was asked — small but load-bearing for the judge: a
   *  rewording is "same conclusion" only relative to what was asked. */
  fixture_input: unknown;
}

/** Verdict returned by the similarity judge. */
export interface SimilarityJudgeOutput {
  /** Yes/no — does the new output convey the same conclusion as the golden? */
  same_conclusion: boolean;
  /** How confident the judge is in its verdict, 0-1. Low confidence here is a
   *  signal for human review even if `same_conclusion` is true. */
  confidence: number;
  /** One paragraph: what's the same and what shifted. */
  notes: string;
  /** Specific wording shifts the judge spotted — empty array if none. */
  differences_named: string[];
  /** Raw model output (for audit / debugging unparsed responses). */
  raw_response: string;
  /** Number of attempts the judge needed (1 = clean parse, 2 = retried once). */
  attempts: number;
}

export interface SimilarityJudgeError {
  judge_error: string;
  raw_response: string;
  attempts: number;
}

/** Judge model — same as PR E's diagnosis judge and PR F's rec judge.
 *  Phase 3 plan resolved Q1: same model for working / eval / judge. */
export const SIMILARITY_JUDGE_MODEL = 'claude-sonnet-4-6';

/** Truncate large outputs so the judge sees structure without choking on
 *  multi-KB tool-result blobs. The regression judge cares about the SHAPE +
 *  CONCLUSION; a 10KB raw transcript is noise here. */
const OUTPUT_TRUNCATE = 6000;

function truncateForJudge(value: unknown): unknown {
  if (value == null) return value;
  const s = JSON.stringify(value);
  if (s.length <= OUTPUT_TRUNCATE) return value;
  return s.slice(0, OUTPUT_TRUNCATE) + '…[truncated for judge]';
}

/** Parse a similarity-judge response. Mirrors the tolerance in judge.ts /
 *  judge-rec.ts: allow ```json fences, allow stray prose before/after, slice
 *  between the first '{' and last '}'. */
function tryParseSimilarityJson(raw: string): SimilarityJudgeOutput | null {
  let text = raw.trim();

  // Strip a ```json … ``` fence if present.
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) text = fenceMatch[1].trim();

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

  const sameConclusion = obj.same_conclusion;
  if (typeof sameConclusion !== 'boolean') return null;

  const confidenceRaw = obj.confidence;
  if (typeof confidenceRaw !== 'number' || !Number.isFinite(confidenceRaw)) return null;
  // Clamp to [0,1] in case the model emits 1.2 or -0.05.
  const confidence = Math.max(0, Math.min(1, confidenceRaw));

  const notes = typeof obj.notes === 'string' ? obj.notes : '';
  const diffsRaw = obj.differences_named;
  const differences_named = Array.isArray(diffsRaw)
    ? diffsRaw.filter((d): d is string => typeof d === 'string')
    : [];

  return {
    same_conclusion: sameConclusion,
    confidence,
    notes,
    differences_named,
    raw_response: raw,
    attempts: 1, // overwritten by caller on retry
  };
}

/**
 * Send the similarity prompt + inputs to Anthropic; parse + return the verdict.
 * On malformed JSON, retries ONCE with a stricter "JSON only" reminder. If both
 * attempts fail, returns a SimilarityJudgeError tagged with the raw response.
 */
export async function judgeSimilarity(
  anthropic: Anthropic,
  input: SimilarityJudgeInput,
  judgePromptText: string,
): Promise<SimilarityJudgeOutput | SimilarityJudgeError> {
  const userMessage = JSON.stringify(
    {
      fixture_id: input.fixture_id,
      agent: input.agent,
      fixture_input: truncateForJudge(input.fixture_input),
      golden_output: truncateForJudge(input.golden_output),
      new_output: truncateForJudge(input.new_output),
    },
    null,
    2,
  );

  const callJudge = async (extraInstruction?: string): Promise<string> => {
    const res = await anthropic.messages.create({
      model: SIMILARITY_JUDGE_MODEL,
      max_tokens: 1500,
      system: judgePromptText,
      messages: [
        {
          role: 'user',
          content:
            (extraInstruction ? `${extraInstruction}\n\n` : '') +
            `Score whether the NEW output conveys the SAME CONCLUSION as the GOLDEN, given the fixture INPUT below. Return JSON only — no prose, no fences.\n\n${userMessage}`,
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
  const parsed1 = tryParseSimilarityJson(raw1);
  if (parsed1) {
    return { ...parsed1, attempts: 1, raw_response: raw1 };
  }

  // Attempt 2 — stricter framing.
  const raw2 = await callJudge(
    'Your previous response was not valid JSON. Return ONLY the JSON object — no markdown, no prose, no fences. Begin with "{" and end with "}".',
  );
  const parsed2 = tryParseSimilarityJson(raw2);
  if (parsed2) {
    return { ...parsed2, attempts: 2, raw_response: raw2 };
  }

  return {
    judge_error: 'Similarity judge returned malformed JSON on both attempts.',
    raw_response: raw2,
    attempts: 2,
  };
}

/** Narrowing helper for callers. */
export function isSimilarityJudgeError(
  v: SimilarityJudgeOutput | SimilarityJudgeError,
): v is SimilarityJudgeError {
  return 'judge_error' in v;
}
