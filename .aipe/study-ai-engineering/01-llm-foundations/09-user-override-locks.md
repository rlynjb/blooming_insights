# 09 — User-override locks

**Type:** Industry standard. Also called: override tracking, override-aware re-classification, human-in-the-loop preservation.

## Zoom out, then zoom in

Not exercised in this repo. This concept file is generated per spec because it's in scope for the LLM-app-engineering shape and would apply if the product grew a user-editable field the LLM re-classifies.

```
  Zoom out — where this pattern would sit in this codebase

  ┌─ UI ──────────────────────────────────────────────────────────────┐
  │  User edits a field on an insight/diagnosis                        │
  │  (does not exist today — no editable fields)                       │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Persistence ───────────────▼─────────────────────────────────────┐
  │  Would need: field + _source ('llm'|'user') + _overridden_at       │
  │  (no persistent DB today; insights live in-memory / demo snapshots)│
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Re-classification ─────────▼─────────────────────────────────────┐
  │  When agent re-runs, checks _overridden_at before overwriting      │
  │  ★ THIS CONCEPT (would apply here) ★                               │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. The pattern's mechanism is simple: any field the user can manually edit gets an `_overridden_at` timestamp; the LLM re-runs check that timestamp and don't overwrite if it's set. In this codebase, no field is user-editable — the UI is read-only over the agent's output. So there's nothing to lock.

## Structure pass

**Layers:**
- Outer: the reader's edited value
- Middle: the persistence layer
- Inner: the re-classification decision

**Axis: authority.**
- Outer: user wins (the edit is the truth)
- Middle: persistence records the override
- Inner: agent respects the override

**Seam:** the `_source` / `_overridden_at` fields on the row. Above: the app treats them as normal fields. Below: any re-classification code branches on them.

## How it works

### Move 1 — the mental model

You've written an `updated_at` timestamp on a database row. Same shape here: an `_overridden_at` timestamp on a field records "the user touched this at time X." Then before the LLM re-runs, you check `if (_overridden_at != null) skip`. That's the whole pattern.

```
  Field with override tracking (industry pattern)

  {
    severity: "critical",              ← current value
    severity_source: "user",           ← who set it
    severity_overridden_at: "2026-06-30T14:00:00Z"  ← when
  }

  On re-classification:
    if (severity_overridden_at != null) {
      // user edited this; do NOT overwrite
      skipReclassification();
    } else {
      severity = agentClassify(...);
      severity_source = "llm";
    }
```

### Move 2 — walk the mechanism (as it would work here)

**Where this WOULD apply in this codebase, hypothetically.**

If the product added:
- Editable `severity` on an `Insight` — user marks a `warning` as `critical` before triaging.
- Editable `bloomreachFeature` on a `Recommendation` — user changes the suggested lever from `scenario` to `campaign`.
- Editable `conclusion` on a `Diagnosis` — user re-writes the agent's conclusion after reviewing.

Each of those fields would need a `_source` + `_overridden_at` companion.

**Why nothing has this today.**

The UI is read-only over agent output. Users click into investigations, expand tool calls, export markdown — but no field is edited. The re-classification problem doesn't arise because there's no re-classification: each investigation is one-shot, results are stashed in `sessionStorage`, and the demo snapshot is captured once and committed.

**The pattern's real cost.**

Every editable field gains a column (or a nested field in the JSON). Migration of existing data (mark all pre-override rows as `_source: 'llm', _overridden_at: null`). The override state has to survive re-runs, syncs, imports/exports.

### Move 3 — the principle

The user is the source of truth for anything they can edit. The LLM is the source of truth for anything they can't. Encode that split in the schema — a `_source` field and a `_overridden_at` timestamp — and every re-classification becomes trivially safe. Skip the pattern and every re-run silently erases user corrections.

## Primary diagram

```
  What the pattern looks like at the schema level (industry standard)

  ┌─ record ──────────────────────────────────────────────┐
  │  {                                                     │
  │    id: '...'                                           │
  │    severity: 'critical',                               │
  │    severity_source: 'user' | 'llm',                    │
  │    severity_overridden_at: null | ISO8601 timestamp,   │
  │    ...                                                 │
  │  }                                                     │
  └────────────────────┬──────────────────────────────────┘
                       │
                       ▼
  Re-classification path:
    for each editable field:
      if overridden_at != null:  keep user value
      else:                       recompute from agent

  This codebase: no editable fields → no records need this shape yet.
```

## Elaborate

The pattern comes from products with dense human-in-the-loop editing over automated classifications — support-ticket categorization, moderation labels, spam filters. Anywhere the model runs on a schedule AND the human can override.

Adjacent patterns: **soft delete** (a `deleted_at` timestamp instead of an actual DELETE, so the record survives for audit); **change tracking** (`updated_at` per field, not just per row); **conflict resolution in local-first sync** (which write wins when two devices edit the same field). All three use timestamps as the arbiter. Override locks are the LLM-specific version.

## Project exercises

### Exercise — editable severity on insights (with lock)

- **Exercise ID:** C1.14-B · Case B (concept not yet exercised).
- **What to build:** add an inline "change severity" control on `InsightCard`. Persist edits to a new `insight_overrides` map keyed by insight id, holding `{severity, severity_source, severity_overridden_at}`. When re-running the monitoring agent, the coordinator checks the override map before overwriting severity in the emitted `Anomaly`.
- **Why it earns its place:** grows the read-only UI into an edit-then-re-classify surface, and the override lock is what keeps re-runs from erasing edits. Interviewer signal: "I know when an LLM's re-classification would erase a user's correction, and here's how I designed around it."
- **Files to touch:** `lib/mcp/types.ts` (add override fields to `Insight`), `lib/state/insights.ts` (persist override map), `components/feed/InsightCard.tsx` (edit control), `lib/agents/monitoring.ts` (apply override on emit).
- **Done when:** editing an insight's severity in the UI persists across re-runs; the demo snapshot capture picks up the override; a test proves re-classification doesn't overwrite a marked override.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Does this codebase have user-override locks?**

No. The UI is read-only over the agent's output — no field is user-editable, so no re-classification can silently erase an override. If we added editability (severity, feature choice, conclusion), each editable field would need a `_source` and `_overridden_at` companion, and the re-run code would need to branch on it. Case B exercise above walks the shape.

**Q: What's the failure mode without this pattern?**

User edits a field, feels satisfied. Agent re-runs on a schedule (or on next investigation), overwrites the edit silently. User's correction is gone. Next time they look, they see the agent's output as if the edit never happened. Trust in the tool erodes fast.

**Q: Where else does the same principle show up?**

Any place a human-provided value competes with an automated recomputation. Support-ticket categorization (rep re-categorizes; system re-runs). Content moderation (moderator marks safe; classifier re-runs). Fraud scoring (analyst clears; scoring pipeline re-runs). Same shape: timestamp the human touch; the automated path skips overridden rows.

## See also

- `lib/mcp/types.ts` — the current `Insight` / `Diagnosis` / `Recommendation` shapes (no override fields)
- `04-agents-and-tool-use/05-agent-memory.md` — related persistence surface (long-term memory) which would also need override awareness
