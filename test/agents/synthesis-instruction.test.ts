// test/agents/synthesis-instruction.test.ts
//
// Byte-identity contract for `buildSynthesisInstruction`. Each test pins the
// assembled string at one of the four agent call sites to the exact text that
// was inlined before the helper was extracted. If a future edit reshapes the
// prefix or closer, these tests fail and force the change to be deliberate.
//
// The middles are kept verbatim per agent (Option A lift): only the shared
// prefix "You have NO more tool calls available. " and shared closer
// " Do not say you need more queries." were lifted into the helper.
import { describe, it, expect } from 'vitest';
import { buildSynthesisInstruction } from '../../lib/agents/base';

describe('buildSynthesisInstruction — byte-identity with pre-lift inline strings', () => {
  it('monitoring: assembles the exact pre-lift string', () => {
    const original =
      'You have NO more tool calls available. Stop querying now and output your final answer. ' +
      'Respond with ONLY a JSON array of anomaly objects in a ```json fence (or [] if nothing ' +
      'meaningful), based on the data you have already gathered. Do not say you need more queries.';
    const middle =
      'Stop querying now and output your final answer. ' +
      'Respond with ONLY a JSON array of anomaly objects in a ```json fence (or [] if nothing ' +
      'meaningful), based on the data you have already gathered.';
    expect(buildSynthesisInstruction(middle)).toBe(original);
  });

  it('diagnostic: assembles the exact pre-lift string', () => {
    const original =
      'You have NO more tool calls available. Stop investigating now and output your final answer. ' +
      'Respond with ONLY a single JSON object in a ```json fence matching the diagnosis shape ' +
      '(conclusion, evidence, hypothesesConsidered). Base it on the evidence you have already gathered — ' +
      'state your best-supported explanation, even if partial. Do not say you need more queries.';
    const middle =
      'Stop investigating now and output your final answer. ' +
      'Respond with ONLY a single JSON object in a ```json fence matching the diagnosis shape ' +
      '(conclusion, evidence, hypothesesConsidered). Base it on the evidence you have already gathered — ' +
      'state your best-supported explanation, even if partial.';
    expect(buildSynthesisInstruction(middle)).toBe(original);
  });

  it('recommendation: assembles the exact pre-lift string', () => {
    const original =
      'You have NO more tool calls available. Stop querying now and output your final answer. ' +
      'Respond with ONLY a JSON array of at most 3 recommendation objects in a ```json fence ' +
      '(or [] if you cannot propose grounded actions), based on the diagnosis and the data you ' +
      'have already gathered. Do NOT include an id field. Do not say you need more queries.';
    const middle =
      'Stop querying now and output your final answer. ' +
      'Respond with ONLY a JSON array of at most 3 recommendation objects in a ```json fence ' +
      '(or [] if you cannot propose grounded actions), based on the diagnosis and the data you ' +
      'have already gathered. Do NOT include an id field.';
    expect(buildSynthesisInstruction(middle)).toBe(original);
  });

  it('query: assembles the exact pre-lift string', () => {
    const original =
      'You have NO more tool calls available. Now answer the user question directly and concisely ' +
      'in plain prose, citing the key numbers you found. Do not say you need more queries.';
    const middle =
      'Now answer the user question directly and concisely ' +
      'in plain prose, citing the key numbers you found.';
    expect(buildSynthesisInstruction(middle)).toBe(original);
  });
});
