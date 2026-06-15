// eval/scripts/lib/structural-diff.ts
//
// Structural diff for the regression eval — conservative comparison of a
// new agent output against a stored golden output along TWO axes:
//
//   1. Required fields: every dotted-path in `requiredFields` must be present
//      in `newOutput` AND its type must match the type at the same path in
//      `goldenOutput`. Missing required fields and type mismatches are HARD
//      FAILS.
//   2. Surprise fields (strict mode only): fields present in `newOutput` at
//      the top level but not in `goldenOutput`. These are reported as
//      warnings (don't fail pass/fail by themselves) so a downstream caller
//      can decide whether to treat a new top-level field as a breaking
//      change.
//
// Dotted paths support array indices via numeric segments — e.g.
//   "recommendations.0.title"  → newOutput.recommendations[0].title
//   "diagnosis.evidence.0"     → newOutput.diagnosis.evidence[0]
//
// Wildcards aren't supported by design: "every recommendation must have a
// title" is expressed by listing the indices that exist in the golden
// (".0.title", ".1.title", ".2.title"). If the new output has fewer
// recommendations than the golden, the missing indices become
// missing_required_fields entries — which is the desired failure mode.

/** Verdict for one structural comparison. */
export interface StructuralDiffResult {
  /** Overall pass: no missing required fields, no type mismatches. */
  pass: boolean;
  /** Required dotted-paths that aren't present in `newOutput`. */
  missing_required_fields: string[];
  /** Required dotted-paths where the type in `newOutput` differs from the
   *  type at the same path in `goldenOutput`. */
  type_mismatches: Array<{ path: string; expected: string; got: string }>;
  /** Top-level fields present in `newOutput` but not in `goldenOutput`.
   *  Warning only (does not fail pass/fail) — call site decides. */
  unexpected_fields: string[];
  /** Free-text notes — e.g. "golden was null; skipping diff", "array length
   *  shrunk from 3 to 2". Useful for the summary writer. */
  notes: string[];
}

/** Config for a single structural diff. */
export interface StructuralDiffConfig {
  /** Dotted-path strings that MUST be present + type-matched in `newOutput`. */
  requiredFields: string[];
  /** When true, also report top-level fields in `newOutput` that aren't in
   *  `goldenOutput` as `unexpected_fields`. Doesn't change pass/fail. */
  strict: boolean;
}

/** Get the value at a dotted path inside an unknown object. Returns the
 *  sentinel `MISSING` (a private symbol) when any segment along the path
 *  is null/undefined or otherwise unreachable. */
const MISSING = Symbol('structural-diff.missing');

function getByPath(target: unknown, path: string): unknown | typeof MISSING {
  if (path.length === 0) return target;
  const segments = path.split('.');
  let cur: unknown = target;
  for (const seg of segments) {
    if (cur == null) return MISSING;
    // Numeric segment = array index.
    if (/^\d+$/.test(seg)) {
      if (!Array.isArray(cur)) return MISSING;
      const idx = Number(seg);
      if (idx < 0 || idx >= cur.length) return MISSING;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return MISSING;
    const obj = cur as Record<string, unknown>;
    if (!(seg in obj)) return MISSING;
    cur = obj[seg];
  }
  return cur;
}

/** Stable type-name for diff comparison. JSON sees a small alphabet:
 *  string / number / boolean / null / array / object. Anything else (function,
 *  bigint, symbol, undefined) is reported as `typeof` for human debugging — those
 *  should never appear in a JSON-serialized agent output, so seeing one in the
 *  diff is itself a signal. */
function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Compare a new agent output to the stored golden output along required-
 * fields + type axes. Returns a StructuralDiffResult; never throws.
 *
 * Important: if `goldenOutput` is null/undefined, the diff is short-circuited
 * to a "pass with a note" — this lets the regression driver call this even
 * before capture mode populates the golden, without crashing.
 */
export function structuralDiff(
  newOutput: unknown,
  goldenOutput: unknown,
  config: StructuralDiffConfig,
): StructuralDiffResult {
  const result: StructuralDiffResult = {
    pass: true,
    missing_required_fields: [],
    type_mismatches: [],
    unexpected_fields: [],
    notes: [],
  };

  if (goldenOutput == null) {
    result.notes.push('golden_output is null — fixture not yet captured; structural diff skipped.');
    return result;
  }

  // 1. Required fields: present + type-matched.
  for (const path of config.requiredFields) {
    const newVal = getByPath(newOutput, path);
    const goldenVal = getByPath(goldenOutput, path);

    if (newVal === MISSING) {
      result.missing_required_fields.push(path);
      result.pass = false;
      continue;
    }
    if (goldenVal === MISSING) {
      // Required field is in `requiredFields` list but isn't actually in the
      // captured golden. That's a fixture-config bug, not a regression — but
      // we can still check that the new value's type is sane (just record a
      // note rather than failing).
      result.notes.push(
        `path "${path}" is in requiredFields but missing from golden_output — fixture config drift?`,
      );
      continue;
    }

    const newType = typeOf(newVal);
    const goldenType = typeOf(goldenVal);
    if (newType !== goldenType) {
      result.type_mismatches.push({ path, expected: goldenType, got: newType });
      result.pass = false;
    }
  }

  // 2. Surprise fields (strict only). Top-level only — recursing would
  //    explode false-positive warnings on the rich nested objects the agents
  //    emit (every Diagnosis carries optional fields the golden may or may
  //    not have happened to populate).
  if (config.strict && isPlainObject(newOutput) && isPlainObject(goldenOutput)) {
    const newKeys = Object.keys(newOutput as Record<string, unknown>);
    const goldenKeys = new Set(Object.keys(goldenOutput as Record<string, unknown>));
    for (const k of newKeys) {
      if (!goldenKeys.has(k)) result.unexpected_fields.push(k);
    }
  }

  return result;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
