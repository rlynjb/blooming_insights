# User-override locks

*Industry standard — `_overridden_at` lock pattern (concept; not yet exercised here)*

## Zoom out — where this concept lives

In codebases where the LLM writes fields the user can also edit, you need a lock — a per-field timestamp that says "the user touched this, don't let the LLM overwrite it on the next sync." **This codebase does not yet exercise the pattern** — there's no user-editable LLM-written field. But it's an honest gap worth naming, because the moment the recommendation card grows an "edit" button, the pattern matters.

```
  Zoom out — where the lock would sit

  ┌─ UI ─────────────────────────────────────────────────────┐
  │  RecommendationCard / EvidencePanel                      │
  │  TODAY: read-only display of LLM-written fields           │
  │  FUTURE: user edits title / rationale / impact            │
  └──────────────────────┬───────────────────────────────────┘
                         │
                         ▼
  ┌─ ★ The lock layer (not implemented) ★ ───────────────────┐ ← we are here
  │  per-field `_source` + `_overridden_at` timestamps        │
  │  agent checks before writing                              │
  └──────────────────────┬───────────────────────────────────┘
                         │
                         ▼
  ┌─ Storage ────────────────────────────────────────────────┐
  │  in-memory + dev-file cache                              │
  │  (no DB to schema-migrate)                               │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** Honest framing: this is a *gap* file, not an *implementation* file. The pattern is named, the mechanism is walked, and the file points at where it would land if the product grows the surface that needs it.

## Structure pass — layers · axes · seams

**Layers:** user input → editable field → storage → agent re-run.

**Axis: who's the source of truth?** Today, the LLM is the only writer to recommendation fields — there's no contention. The pattern matters the moment a user can also write to those same fields and the agent re-runs.

**Seam:** the field write-back path. Today, agent output goes straight into in-memory state and the demo snapshot. There's no "merge user edits with agent output" merge layer, because there are no user edits yet.

## How it works

### Move 1 — the mental model

You know how Git refuses to overwrite your uncommitted changes when you pull? Same idea, applied per-field. The LLM is a "pull" of generated content; user edits are "uncommitted changes"; the lock is the refusal to overwrite.

```
  Lock pattern — field-level, three-way state

  field schema:
    title:                "Boost USA revenue via cart recovery"
    title_source:         "llm"         ← who wrote it
    title_overridden_at:   null          ← timestamp if user edited

  next LLM run:
    if (title_overridden_at != null) {
      // user edited this; do NOT overwrite
      keep_user_value();
    } else {
      title = llm.generate();
      title_source = "llm";
    }
```

### Move 2 — the step-by-step walkthrough

**Part 1 — what the pattern would look like in this codebase.**

The `Recommendation` shape today (`lib/mcp/types.ts:117-131`) has plain fields:

```typescript
export interface Recommendation {
  id: string;
  title: string;
  rationale: string;
  bloomreachFeature: 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment';
  steps: string[];
  estimatedImpact: EstimatedImpact;
  confidence: 'high' | 'medium' | 'low';
  // ... optional enrichments
}
```

If the recommendation card grew an "edit title" affordance, the shape would need:

```typescript
export interface Recommendation {
  id: string;
  title: string;
  title_source: 'llm' | 'user';          // who wrote it
  title_overridden_at: string | null;    // when user edited (ISO)
  rationale: string;
  rationale_source: 'llm' | 'user';
  rationale_overridden_at: string | null;
  // ... per editable field
}
```

The agent (or its writer side) would check `_overridden_at` before writing:

```typescript
// pseudocode for the next recommendation re-run
for (const field of EDITABLE_FIELDS) {
  if (recommendation[`${field}_overridden_at`] != null) {
    continue;  // user has edited this — preserve their value
  }
  recommendation[field] = newRecommendation[field];
  recommendation[`${field}_source`] = 'llm';
}
```

**Part 2 — what the agent loop would need to know.**

The agent itself doesn't write to storage today — the route does, via `putInsights()` at `lib/state/insights.ts:62`. The lock check belongs at the *write boundary*, not inside the agent. The agent emits a fresh `Recommendation`; the merge logic compares against the stored one and respects overrides.

This is the right separation: the agent stays stateless (every run is fresh); the merge logic stays small (one function, easy to test) and lives where storage lives.

**Part 3 — the demo-snapshot wrinkle.**

If user edits land, the demo snapshot at `lib/state/demo-investigations.json` needs a story. Two options:

  1. **Treat the snapshot as canonical, no editing in demo mode.** Simplest. The UI disables edit buttons when `bi:mode === 'demo'`.
  2. **Persist edits to a separate per-session overlay.** More complex; means demo sessions accumulate state, which contradicts the "demo is reliable presentation" framing.

Option 1 is the right move for this codebase's product shape (demo IS the presentation path).

### Move 3 — the principle

**Any LLM-writable field the user can also edit needs a per-field `_overridden_at` lock.** The merge logic is small but load-bearing — without it, user edits silently disappear on the next agent run. Lock pattern + write-time merge + read-time honest provenance display.

## Primary diagram — the full recap

```
  User-override lock — three-way state (not implemented today)

  ┌─ Storage ────────────────────────────────────────────────────┐
  │  Recommendation {                                            │
  │    title: "...",   title_source: "llm",   _overridden_at: ?  │
  │    rationale: "...", rationale_source: "llm", _overridden_at:?│
  │    ...                                                       │
  │  }                                                           │
  └──────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
  ┌─ Read path (UI) ─────────────────────────────────────────────┐
  │  if (_overridden_at):  render with "edited by you" badge     │
  │  else:                 render with "from agent" badge        │
  └──────────────────────────────────────────────────────────────┘
                         │
                         ▼
  ┌─ Write path A: user edit ────────────────────────────────────┐
  │  user types in title field, blurs                            │
  │  → write title = new value                                   │
  │  → write title_source = "user"                               │
  │  → write title_overridden_at = now                           │
  └──────────────────────────────────────────────────────────────┘
                         │
                         ▼
  ┌─ Write path B: agent re-run ─────────────────────────────────┐
  │  agent emits new Recommendation                              │
  │  for each editable field:                                    │
  │    if (stored._overridden_at != null): skip                  │
  │    else: stored[field] = new[field], _source = "llm"         │
  └──────────────────────────────────────────────────────────────┘

  Today: write paths A and B don't exist. The whole picture is
         the gap to be designed when the surface grows.
```

## Elaborate

**Why this is worth a file even though it's not implemented.** Three reasons:

  1. **The pattern is interview-standard.** Anyone who's built an LLM app where the model writes user-editable fields knows this trap. Naming the gap (vs faking implementation) makes the file honest.
  2. **The product is one click from needing it.** The recommendation card currently has a "copy to clipboard" affordance, not "edit." The moment an "edit rationale" button lands — and product instinct says it will, because analysts want to tweak the language before sharing — the lock matters. Designing the schema *before* the surface ships is cheaper than retrofitting.
  3. **The audit's "what's not yet exercised" lens lives here.** This is part of being honest in the audit, not aspirational in the implementation.

**The trap to avoid when implementing.** The naive version stores `_source: 'llm' | 'user'` only — no timestamp. That breaks when:
  - User edits, then agent runs. Source flips back to `'llm'`. User edit lost silently.
  - The fix is the *timestamp*: once it's set, it stays set, and the agent skips the field forever (or until the user explicitly resets it). The source field becomes purely informational.

## Project exercises

### Exercise — Add edit affordances to RecommendationCard with proper lock semantics

  → **Exercise ID:** B1.9
  → **What to build:** Add an "edit title" and "edit rationale" affordance to `components/investigation/RecommendationCard.tsx`. Extend the `Recommendation` shape with `_source` and `_overridden_at` fields for `title` and `rationale`. Implement the merge logic at the storage write boundary (in `lib/state/insights.ts` or a new `lib/state/recommendations.ts`) that respects `_overridden_at` on agent re-runs. UI shows an "edited by you" badge when present.
  → **Why it earns its place:** introduces a load-bearing pattern any LLM app eventually needs; turns the "not yet exercised" audit finding into "exercised correctly". Forces you to design the merge logic at the storage boundary, not in the agent or UI.
  → **Files to touch:** `lib/mcp/types.ts` (extend `Recommendation` with `_source` / `_overridden_at` per editable field), new `lib/state/merge.ts` (write-time merge with lock respect), `components/investigation/RecommendationCard.tsx` (edit affordances + badge), `test/state/merge.test.ts` (cover all three write paths: fresh, user-edit, agent-re-run-after-user-edit).
  → **Done when:** an integration test demonstrates a user edit surviving an agent re-run, the UI surfaces the "edited by you" badge, and the demo mode disables edit affordances (per the snapshot-as-canonical decision).
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "Why isn't this in the codebase yet?"**

Because the surface doesn't exist. Today there's no user-editable LLM-written field — the recommendation card shows the agent's output read-only. The pattern only matters once a user can edit a field the agent will overwrite on its next run. I've named the gap in the audit and shaped the implementation so it lands cleanly when the product grows the affordance.

*Anchor: "Not yet exercised; the implementation lands the moment the recommendation card grows an edit button. Pattern is per-field `_overridden_at` + write-time merge."*

**Q: "Why a timestamp instead of just a source flag?"**

Because the source flag alone is fragile — agent re-runs would flip `source` back to `'llm'` and silently overwrite the user's edit. A timestamp, once set, is sticky: the agent skips the field forever unless the user explicitly resets it. The source field becomes informational; the lock is the timestamp.

*Anchor: "Timestamp is the lock; source is the badge. The naive `source` flag alone breaks on re-runs."*

## See also

  → `04-structured-outputs.md` — the typed contracts the lock would attach to
  → `04-agents-and-tool-use/06-error-recovery.md` — adjacent concept: what the agent does when its write is blocked
  → `study-data-modeling` — the data-modeling guide carries the broader schema-evolution story this would slot into
