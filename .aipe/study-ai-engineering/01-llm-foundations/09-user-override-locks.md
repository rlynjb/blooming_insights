# 09 — user override locks

**Subtitle:** Lock LLM-generated fields the user can correct · Industry standard (Case B)

## Zoom out, then zoom in

**Case B: not exercised in this codebase.** Blooming today has no
user-editable LLM-generated fields. Every LLM output (anomaly summary,
diagnosis conclusion, recommendation rationale) flows from agent → snapshot
→ render. The user reads them; they don't edit them. So the
override-lock pattern isn't *needed* here yet.

This file teaches the pattern and names the concrete refactor target if you
wanted to add it — the recommendation card's `title` and `rationale` are the
natural first place.

```
  Zoom out — where override locks would live (Case B refactor)

  ┌─ Agent layer ─────────────────────────────────────────┐
  │  RecommendationAgent emits { title, rationale, … }   │
  └─────────────────┬─────────────────────────────────────┘
                    │  save
                    ▼
  ┌─ State (lib/state/investigations.ts) ─────────────────┐
  │  TODAY: no overrides — every re-run overwrites blindly│
  │  REFACTOR: add `title_source`, `title_overridden_at`  │  ← we are here
  └─────────────────┬─────────────────────────────────────┘
                    │
                    ▼
  ┌─ UI (RecommendationCard) ─────────────────────────────┐
  │  TODAY: read-only render                              │
  │  REFACTOR: inline edit + save → marks _overridden_at  │
  └───────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — authority.** Two writers want to own the same
    field: the LLM (re-generates on every run) and the user (edits when
    the LLM was wrong). Without a lock, the most recent writer wins —
    which is always the LLM, because re-runs happen automatically and
    user edits don't carry a "do not overwrite" flag.

  → **The seam:** between the persistence layer (`lib/state/investigations.ts`)
    and the agent output. The lock lives in the persistence layer because
    that's where the LLM's re-write would otherwise win.

## How it works

### Move 1 — the mental model

You've seen this pattern in any system with conflict resolution: optimistic
locking, a `last_modified_by` column, "user override" toggles. The shape is
*track who wrote what, and check before overwriting*.

```
  Field with override tracking (the pattern)

  ┌────────────────────────────────────────────┐
  │ {                                          │
  │   title:           "Re-engage…",            │
  │   title_source:    "llm",      ← who set it│
  │   title_overridden_at: null   ← when user │
  │                                  edited   │
  │ }                                          │
  └────────────────────────────────────────────┘

  When the LLM re-runs:

   if (rec.title_overridden_at != null) {
     // user has corrected this; keep their wording
     rec.title = oldRec.title;
   } else {
     rec.title = llmTitle;        // free to overwrite
     rec.title_source = 'llm';
   }
```

### Move 2 — the step-by-step walkthrough (Case B — the refactor)

**Where the field lives today.** `Recommendation` (`lib/mcp/types.ts:116-130`):

```typescript
export interface Recommendation {
  id: string;
  title: string;             // ← would gain title_source, title_overridden_at
  rationale: string;         // ← same
  bloomreachFeature: 'scenario' | 'segment' | 'campaign' | 'voucher' | 'experiment';
  steps: string[];
  estimatedImpact: EstimatedImpact;
  confidence: 'high' | 'medium' | 'low';
  // ── business-owner enrichments (Tier 1). All optional, agent-emitted. ──
  effort?: 'low' | 'medium' | 'high';
  timeToSetUpMinutes?: number;
  readResultInDays?: number;
  prerequisites?: { label: string; satisfied: boolean }[];
  successMetric?: string;
}
```

Today every field is unconditionally set by `RecommendationAgent.propose()`,
and the saved investigation overwrites the previous one on re-run.

**The refactor — add override tracking.** Extend the type with optional
override fields:

```typescript
export interface Recommendation {
  id: string;
  title: string;
  title_source?: 'llm' | 'user';                    // ← new
  title_overridden_at?: string;                     // ← new (ISO timestamp)
  rationale: string;
  rationale_source?: 'llm' | 'user';
  rationale_overridden_at?: string;
  // … rest unchanged
}
```

**The check on re-run** — extend `saveInvestigation` in
`lib/state/investigations.ts` to merge against the prior version:

```typescript
function applyOverrideLocks(prev: Recommendation, next: Recommendation): Recommendation {
  const merged: Recommendation = { ...next };
  if (prev.title_overridden_at) {
    merged.title = prev.title;
    merged.title_source = 'user';
    merged.title_overridden_at = prev.title_overridden_at;
  }
  if (prev.rationale_overridden_at) {
    merged.rationale = prev.rationale;
    merged.rationale_source = 'user';
    merged.rationale_overridden_at = prev.rationale_overridden_at;
  }
  return merged;
}
```

**The UI edit path** — add a "edit title" affordance to
`components/investigation/RecommendationCard.tsx`. On save, POST to a new
route `/api/recommendations/[id]/title` that updates the field and sets
`title_source: 'user'` + `title_overridden_at: new Date().toISOString()`.

**The validation guard** — `lib/mcp/validate.ts:42-57` already ignores
unknown fields, so the new `_source` / `_overridden_at` fields ride through
without breaking the existing parser. Older snapshots without the fields
treat them as `undefined`, which means "no override" — matching today's
behavior.

### Move 3 — the principle

**Any field with two writers needs a lock per writer.** The LLM is one
writer; the user is the other. Without explicit tracking of *which writer
wrote last and when*, the higher-frequency writer always wins. In LLM-shaped
systems the LLM is always the higher-frequency writer (re-runs are
automated), so the user's corrections evaporate silently.

The pattern transcends LLM apps. Replication systems have it (last-write-wins
+ vector clocks); CRDT systems make it explicit; collaborative editors
fight it constantly. In LLM apps it's specifically about *the user's
authority surviving an automated re-run*.

## Primary diagram

```
  Override lock pattern — Case B refactor

  ┌─ Field with no lock (TODAY) ─────────────────────────┐
  │  {                                                   │
  │    title: "<latest LLM output>"                      │
  │  }                                                   │
  │  Re-run overwrites silently. User edits not possible.│
  └──────────────────────────────────────────────────────┘

  ┌─ Field with lock (REFACTOR) ─────────────────────────┐
  │  {                                                   │
  │    title: "User's corrected version",                │
  │    title_source: "user",                             │
  │    title_overridden_at: "2026-06-15T10:00:00Z"       │
  │  }                                                   │
  │  Re-run checks _overridden_at and keeps user value. │
  └──────────────────────────────────────────────────────┘

  Re-run flow:

   new agent output
        │
        ▼
   prevRecommendation.title_overridden_at != null?
        │
   ┌────┴─────┐
   │          │
   ▼ yes      ▼ no
   keep prev  overwrite from agent output
   title      title_source = 'llm'
```

## Elaborate

The override-lock pattern doesn't show up in this codebase because the
product surface today is *read-only outputs*. The user reads the briefing,
reads the diagnosis, reads the recommendation, and clicks "open this in
Bloomreach" — the actual ACTION lives in Bloomreach, not in this app. The
moment Blooming gains any user-editable LLM-produced field (recommendation
wording, manual hypothesis additions to a diagnosis, custom severity
overrides on insights), this pattern lands.

A related pattern: *acknowledgment without editing*. If the user can
"dismiss" an anomaly or "snooze" a recommendation, that's a single boolean
that needs to survive re-runs. Same shape, simpler implementation — one
`dismissed_at` timestamp per insight. This is a lighter version of the
override lock and is probably the right *first* lock to add, before going
full editable-fields.

## Project exercises

### Exercise — add a "dismiss this anomaly" override

  → **Exercise ID:** `study-ai-eng-09.1`
  → **What to build:** Add `dismissed_at?: string` to `Insight`. UI: an "x"
    button on each `InsightCard` that POSTs to `/api/insights/[id]/dismiss`
    and sets the field. Briefing replay filters out insights with
    `dismissed_at` set, so a re-monitoring run doesn't re-show them. (The
    monitoring agent itself can still produce them; the persistence layer
    suppresses.)
  → **Why it earns its place:** Smallest possible override lock. Lets the
    user have one source of authority (this isn't worth surfacing) that
    survives the next re-run. Lands the pattern before tackling editable
    text.
  → **Files to touch:** `lib/mcp/types.ts` (extend Insight), `lib/state/insights.ts`
    (merge logic), new `app/api/insights/[id]/dismiss/route.ts`,
    `components/feed/InsightCard.tsx` (button), `lib/hooks/useBriefingStream.ts`
    (filter dismissed in render).
  → **Done when:** Dismissing an insight hides it; re-running the briefing
    keeps it hidden; the dismissed insight is queryable for "show
    dismissed" view.
  → **Estimated effort:** `1–4hr`

### Exercise — add editable `title` + `rationale` overrides to recommendations

  → **Exercise ID:** `study-ai-eng-09.2`
  → **What to build:** Full override-lock pattern on `Recommendation.title`
    and `.rationale` as described in the walkthrough above. Inline edit in
    the recommendation card; save persists the override; re-running the
    recommendation agent preserves the user's wording.
  → **Why it earns its place:** The recommendation prose is the most
    visible LLM output in the product. A marketer might want to soften
    the tone or reword for their team. Without the lock, the next
    investigation overwrites their edit silently.
  → **Files to touch:** `lib/mcp/types.ts` (override fields),
    `lib/state/investigations.ts` (merge), new
    `app/api/recommendations/[id]/edit/route.ts`,
    `components/investigation/RecommendationCard.tsx` (inline edit), validators.
  → **Done when:** Editing a recommendation's title survives a recommendation-
    agent re-run; demo capture preserves the override in the snapshot.
  → **Estimated effort:** `1–2 days`

## Interview defense

**Q: Does blooming insights let users edit LLM-generated fields?**

Not today. Every LLM output (anomaly summary, diagnosis conclusion,
recommendation rationale) is read-only. The user reads them, clicks
through, and acts in Bloomreach. Because there's no edit path, there's no
lock — which is the right call right now.

If we added editable fields, the override-lock pattern is what would land
first: a `_source` field naming who wrote the value (`'llm' | 'user'`) and a
`_overridden_at` timestamp. The agent re-run checks `_overridden_at` before
overwriting; if it's set, the user's value stays.

```
  Override lock — the canonical shape:

  field:               "the value"
  field_source:        "user" | "llm"
  field_overridden_at: "2026-06-15T10:00:00Z" | null

  On re-run: if _overridden_at, skip overwriting that field.
```

**Anchor line:** "Not exercised yet. The recommendation `title` and
`rationale` are the right first fields — high visibility, easy to want to
correct."

**Q: Why is this load-bearing for any LLM app that eventually adds editing?**

LLMs re-run often (per session, per data refresh, per cache miss). The user
edits once. Without the lock, the user's edit gets erased on the next re-run
and they think the system is broken. The lock is what makes user authority
survive automation.

**Anchor line:** "Two writers, one field. The lock is which writer wins."

## See also

  → `04-structured-outputs.md` — the validator that already ignores unknown
    fields, so the override-tracking fields ride through transparently
  → `05-evals-and-observability/04-llm-observability.md` — logging override
    events as eval-quality signal (when do users override? for which kinds of
    recommendations?)
