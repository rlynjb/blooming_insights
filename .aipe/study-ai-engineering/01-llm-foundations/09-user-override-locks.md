# User-override locks (don't let a re-run clobber a human edit)

**Industry name(s):** user-override locks, write-protection / dirty-field tracking, last-write-wins vs. user-wins reconciliation
**Type:** Industry standard · Language-agnostic

> When a machine-generated value can also be edited by a human, a re-run must not silently overwrite the human's edit; the standard guard is a per-field `_overridden_at` timestamp that the regeneration step checks before writing. blooming insights is a read-only analyst — no user-editable persisted fields exist — so this is study material and a buildable target, not a present feature.

**See also:** → 04-structured-outputs.md · → 01-what-an-llm-is.md · → 06-token-economics.md

---

## Why care

You build a form whose fields are pre-filled from an API. The user edits one field, then a background refetch returns fresh server data. If you naively `setState(serverData)`, the user's edit vanishes — they watch their typing get erased by a refresh they did not ask for. The fix every frontend engineer learns: track which fields the user touched (a `dirty` set) and merge so server data fills only the untouched fields. The user's edits win; the refresh fills the gaps.

The same conflict appears wherever a machine regenerates a value a human can also change. An LLM that re-runs an investigation and re-proposes recommendations is a refresh. If a user dismissed or edited a recommendation, a re-run must not resurrect or overwrite it.

**The pivot: regeneration and human editing share a field, so you need a rule for who wins — and "last write wins" silently destroys the human's intent.** Without an explicit marker of "a human touched this," the regeneration step cannot tell a user edit from stale machine output, so it overwrites both. The marker — a per-field `_overridden_at` timestamp — is what lets the re-run skip the fields a human owns.

Before the lock:
- A user edits a recommendation's title; the next investigation re-run overwrites it with fresh machine output
- A dismissed recommendation reappears on every re-run
- The user learns the tool does not respect their input and stops editing

After:
- An edited field carries `_overridden_at`; the re-run sees it and skips it
- Dismissed items stay dismissed
- The machine fills only what the human has not claimed

It is the dirty-field merge from a pre-filled form, persisted to the data model and checked by the regeneration step.

---

## How it works

**Mental model.** Every regenerable field gets an optional companion marker recording when (and by whom) a human last overrode it. The regeneration step is no longer "write the new value" — it is "write the new value *only if* no override marker is present (or the new data is genuinely newer than the override)." It is the `dirty` set from a controlled form, except it lives on the persisted record and the "refetch" is an LLM re-run.

```
field lifecycle
  machine generates  → value, _overridden_at = undefined
  human edits        → value', _overridden_at = now()      ← human claims it
  re-run regenerates → check _overridden_at:
                         undefined → write new value
                         set       → SKIP (human owns it)
```

The marker turns an ambiguous "these two values differ" into an unambiguous "a human chose this one." Reconciliation is then a single rule applied per field.

---

### The conflict the marker resolves

Two writers target the same field — the LLM (on every re-run) and the user (on edit). Without a marker, the regeneration step cannot distinguish a user's deliberate edit from an old machine value:

```
                 field: recommendation.title
   ┌──────────────┐                    ┌──────────────┐
   │  LLM re-run   │ ──── writes ────▶  │  persisted    │ ◀─── edits ── user
   │ (every run)   │                    │   record      │
   └──────────────┘                    └──────────────┘
        last write wins → whoever wrote last clobbers the other
        the user almost always loses (the re-run is automated)
```

The marker breaks the symmetry: a human edit is *flagged*, so the re-run can defer to it.

```
   re-run wants to write title
        │
   _overridden_at present?
   ┌────┴────┐
   │ yes     │ no
   │ SKIP    └──▶ write new title
   ▼
   keep the human's title
```

---

### Where the marker lives: the data model

The lock is a schema change first. A regenerable type gains optional override metadata — at minimum a timestamp, often per-field:

```
interface Recommendation {
  id: string;
  title: string;
  rationale: string;
  bloomreachFeature: ...;
  steps: string[];
  estimatedImpact: string;
  confidence: ...;
  // override metadata (NEW)
  _overridden_at?: string;          // ISO timestamp of the human edit
  _overridden_fields?: string[];    // optional: which fields the human owns
  _dismissed?: boolean;             // a dismissal is an override too
}
```

The marker is *optional* so existing machine-generated records (no human touch) carry nothing — absence means "machine owns it." The presence of the marker is the signal.

---

### Where the marker is checked: the regeneration step

The re-run's write becomes a merge. Conceptually:

```
mergeOnRegenerate(existing, fresh):
  for each field in fresh:
    if existing._overridden_at is set AND field is human-owned:
      keep existing[field]        ← human wins
    else:
      existing[field] = fresh[field]   ← machine fills
  return existing
```

There are two defensible reconciliation policies, and choosing is the design decision:

```
policy A — user always wins        policy B — newest wins
─────────────────────────────      ──────────────────────────────
if _overridden_at set → keep        if fresh.generatedAt > _overridden_at
human edit is permanent              → machine value (data moved on)
simplest, most respectful            else → keep human edit
                                     handles "the edit is now stale"
```

Policy A is the safer default (never surprise the user); Policy B handles the case where the underlying data changed so much the human's edit is obsolete. The marker supports either — it is the *timestamp* that makes Policy B even expressible.

---

### The principle

When two writers — a regenerating machine and an editing human — share a field, you must encode *who owns it*, because "last write wins" defaults to the machine and silently destroys human intent. A per-field `_overridden_at` marker is the minimal encoding: it flags the human's claim so the regeneration step can defer to it. The same dirty-field discipline that protects a user's typing in a refetching form protects a user's edits from an LLM re-run.

---

## User-override locks — diagram

This diagram spans the UI (where the human edits), the State layer (where the marker is persisted), and the Service layer (where the regeneration step checks it). A reader who sees only this should grasp that the marker lives on the record and gates the re-run's write.

```
┌──────────────────────────────────────────────────────────────────────┐
│  UI LAYER                                                             │
│   user edits / dismisses a recommendation                            │
│        │  PATCH                                                       │
└────────┼───────────────────────────────────────────────────────────────┘
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  STATE LAYER  (lib/state/, lib/mcp/types.ts)                         │
│   Recommendation { ...fields, _overridden_at?, _dismissed? }         │
│   on edit → _overridden_at = now()    ← the human claims the field    │
└────────┬───────────────────────────────────────────────────────────────┘
         │  read on re-run
┌────────▼───────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (RecommendationAgent.propose + a merge step)        │
│   re-run produces fresh recommendations                              │
│        │                                                             │
│   mergeOnRegenerate(existing, fresh):                               │
│      _overridden_at set?  ── yes ──▶ KEEP human value               │
│                           ── no  ──▶ WRITE fresh value              │
│        │                                                             │
│        ▼                                                             │
│   persisted record: human edits preserved, gaps refreshed           │
└────────────────────────────────────────────────────────────────────────┘
```

The marker on the State-layer record is the contract between the human (UI) and the machine (Service): the re-run reads it and defers to the human where it is set.

---

## In this codebase

**Not yet implemented.** blooming insights is a read-only analyst — it streams a diagnosis and recommendations for viewing and Markdown export, but there are no user-editable persisted fields, so there is no regeneration-vs-edit conflict to guard and no `_overridden_at` anywhere.

This is confirmed by the data model and state: `lib/mcp/types.ts` defines `Recommendation` (L58–L66) and `Diagnosis` (L47–L52) with *only* machine-generated fields — no override metadata, no `_dismissed`, no `_overridden_at`. `lib/state/insights.ts` exposes `putInsights` / `getInsight` / `getAnomaly` / `putInvestigation` (L24–L49) and an in-memory `Map` store with *no edit or patch path* — every write is a machine write. The investigate UI (`app/investigate/[id]/page.tsx`) renders recommendations as read-only cards and offers Markdown export (L253–L264) but no edit or dismiss control. The `id` assigned to each recommendation (`lib/agents/recommendation.ts` L76) exists for React keys and rendering, not for tracking human edits.

Where the lock would live: `lib/mcp/types.ts` (`Recommendation` gains `_overridden_at?` / `_dismissed?`), `lib/state/` (a patch/edit path that sets the marker, and a `mergeOnRegenerate` used by re-runs), and `app/investigate/[id]/page.tsx` (edit/dismiss controls). The `Project exercises` block below is the primary buildable target.

---

## Elaborate

### Where this pattern comes from

The conflict is a special case of *concurrent update reconciliation*, the same problem databases solve with optimistic locking (a version column checked on write) and distributed systems solve with vector clocks or last-write-wins registers. The frontend incarnation is the controlled-form `dirty`-field merge; the collaborative-editing incarnation is operational transforms / CRDTs. The `_overridden_at` marker is the lightest member of this family: a single timestamp per record (or per field) that records "a human asserted this value," enough to implement a user-wins policy without full version vectors.

In LLM products specifically, this surfaces the moment a generated artifact becomes editable: an AI-drafted email the user tweaks, an AI-categorized expense the user re-categorizes, an AI recommendation the user dismisses. Every one of these needs a rule so the next generation pass does not undo the human's correction.

### The deeper principle

```
who owns the field?              encoding                policy
──────────────────────────────  ──────────────────────  ──────────────────
machine only                    nothing                 always regenerate
human can override              _overridden_at marker    user-wins / newest-wins
collaborative (many humans)     version vector / CRDT    merge / OT
```

The marker is the minimum viable ownership encoding for the two-writer (one machine, one human) case. Scale up to many concurrent human editors and you need richer machinery; for AI-regenerated-but-human-correctable fields, a timestamp is exactly enough.

### Where this breaks down

1. **A whole-record timestamp is too coarse for field-level edits.** A single `_overridden_at` on the `Recommendation` means editing the title locks *every* field, so the machine can no longer refresh `estimatedImpact` even though the human never touched it. Field-level markers (`_overridden_fields`) fix this at the cost of more bookkeeping.

2. **"User always wins" can preserve stale edits forever.** If the underlying data changes drastically, a human's months-old edit may now be wrong, but Policy A keeps it. Policy B (newest-wins via timestamp comparison) handles this — but requires the machine output to carry its own `generatedAt`, another field.

3. **Dismissal is an override too, and easy to forget.** A dismissed recommendation that the re-run regenerates is the same bug as an overwritten edit. The marker design must treat `_dismissed` as a form of override, or dismissed items resurrect on every run.

### What to explore next

- **Field-level override tracking (`_overridden_fields`):** lock only what the human touched, leave the rest regenerable.
- **Newest-wins reconciliation:** compare the override timestamp to the fresh output's generation time so genuinely stale edits can be superseded.
- **Optimistic locking with a version column:** the database-native form of the same guard, for when records move to a real datastore.

---

## Tradeoffs

### `_overridden_at` marker (user-wins) vs. last-write-wins vs. full versioning

| Dimension | `_overridden_at` marker | Last-write-wins (no marker) | Full version vectors / CRDT |
|---|---|---|---|
| Respects human edits | Yes | No — re-run clobbers them | Yes |
| Implementation cost | One optional field + a merge check | Zero | High — vectors, merge logic |
| Field-level granularity | With `_overridden_fields` | N/A | Native |
| Handles many concurrent humans | No (one human assumed) | No | Yes |
| Stale-edit handling | Policy B (needs a second timestamp) | N/A | Native |
| Right when | One human can correct machine output | Machine output is never edited | Real-time multi-user collaboration |

**What we gave up (by not having it).** Nothing today — there are no editable fields, so there is no conflict. The cost is *latent*: the day recommendations become dismissible or editable, shipping that feature *without* the marker means a re-run silently destroys user edits, which trains users to distrust the tool. The marker is cheap insurance that must be added *with* the edit feature, not after.

**What the alternative would have cost.** Last-write-wins (shipping editability with no marker) costs user trust the first time a re-run erases an edit — a silent, infuriating bug. Full versioning costs implementation effort disproportionate to a single-human-corrects-machine scenario. The marker is the right-sized middle.

**The breakpoint.** No lock is correct while the data is read-only (the current state). The instant a single edit/dismiss control ships, the `_overridden_at` marker becomes mandatory — that feature and that marker are the same change. If the product later gains *multiple concurrent human editors* of the same recommendation, the single-timestamp marker is no longer sufficient and full versioning (optimistic locking or CRDTs) becomes the required upgrade.

---

## Tech reference (industry pairing)

### per-field override marker (`_overridden_at`)

- **Codebase uses:** nothing — `Recommendation` (`lib/mcp/types.ts` L58–L66) has no override metadata; the data is read-only.
- **Why it's here (absent):** the analyst does not expose editable fields, so there is no regeneration-vs-edit conflict to guard.
- **Leading today:** dirty-field tracking with a per-field timestamp/flag is the standard guard for AI-generated-but-human-editable values (2026).
- **Why it leads:** minimal encoding of human ownership; a single optional field plus a merge check implements user-wins.
- **Runner-up:** an `is_user_modified` boolean — simpler but loses the timestamp needed for newest-wins reconciliation.

### optimistic locking (version column)

- **Codebase uses:** nothing — state is an in-memory `Map` (`lib/state/insights.ts` L3–L5) with machine-only writes.
- **Why it's here (absent):** no concurrent writers and no persistent store where a write race could occur.
- **Leading today:** version/`updated_at` columns checked on write are the database-native concurrency guard (2026).
- **Why it leads:** detects and rejects conflicting writes at the storage layer, independent of application logic.
- **Runner-up:** row-level locks — stronger isolation, more contention.

### CRDTs / operational transforms

- **Codebase uses:** nothing.
- **Why it's here (absent):** there is one writer-pair (machine + a single human), not real-time multi-user collaboration.
- **Leading today:** Yjs / Automerge lead for collaborative editing (2026).
- **Why it leads:** they merge concurrent edits from many users without a central lock.
- **Runner-up:** OT (the Google Docs lineage) — powerful, harder to implement than CRDTs.

---

## Project exercises

### Add dismissible/editable recommendations with `_overridden_at` locks

- **Exercise ID:** B1.9 (adapted) — user-override locks, the primary buildable target.
- **What to build:** make recommendations dismissible and title/rationale-editable; persist an `_overridden_at` (and `_dismissed`) marker on edit; add a `mergeOnRegenerate(existing, fresh)` step so a re-investigation preserves human-owned fields and dismissals instead of overwriting them.
- **Why it earns its place:** demonstrates you anticipated the regeneration-vs-edit conflict and chose a reconciliation policy — the exact judgment that separates "ship the edit feature" from "ship it without erasing user intent."
- **Files to touch:** `lib/mcp/types.ts` (`Recommendation` gains `_overridden_at?` / `_dismissed?`), `lib/state/insights.ts` (a patch path that sets the marker; `putInvestigation` merge), a new `lib/state/merge.ts` (`mergeOnRegenerate`), `app/investigate/[id]/page.tsx` (edit/dismiss UI), `lib/agents/recommendation.ts` (re-run feeds through the merge).
- **Done when:** editing a recommendation's title then re-running the investigation preserves the edit, a dismissed recommendation stays dismissed across re-runs, and untouched fields still refresh.
- **Estimated effort:** 1–2 days

### Upgrade to field-level locks with newest-wins reconciliation

- **Exercise ID:** B1.9 (adapted) — granular reconciliation.
- **What to build:** replace the whole-record `_overridden_at` with `_overridden_fields: string[]` and add a `generatedAt` to fresh output so `mergeOnRegenerate` can apply newest-wins: keep the human field unless the fresh data is materially newer than the override.
- **Why it earns its place:** shows you found the coarse-timestamp flaw (one edit locks the whole record) and the stale-edit flaw, and fixed both.
- **Files to touch:** `lib/mcp/types.ts` (`_overridden_fields`, `generatedAt`), `lib/state/merge.ts` (per-field + timestamp policy), the corresponding tests.
- **Done when:** editing only the title lets the machine still refresh `estimatedImpact` on re-run, and a sufficiently newer machine value can supersede an old human edit under the chosen policy.
- **Estimated effort:** 1–2 days

---

## Summary

When a machine regenerates a value a human can also edit, "last write wins" defaults to the machine and silently destroys the human's edit; the standard guard is a per-field `_overridden_at` marker the regeneration step checks before writing, deferring to the human where it is set. blooming insights does not have this because it is a read-only analyst — `Recommendation` and `Diagnosis` (`lib/mcp/types.ts`) carry only machine fields, `lib/state/insights.ts` has no edit path, and the UI is view-and-export only. The lock becomes mandatory the moment editability ships; building it is the dirty-field merge from a controlled form, persisted to the data model.

**Key points:**
- Regeneration and human editing share a field, so you must encode *who owns it* — the marker is that encoding.
- Without `_overridden_at`, a re-run cannot tell a deliberate edit from stale machine output and overwrites both.
- blooming insights is read-only: no editable persisted fields, so no conflict and no marker today.
- A dismissal is an override too — forget it and dismissed items resurrect on every re-run.
- The lock and the edit feature are the same change; shipping editability without it is a silent trust-destroying bug.

---

## Interview defense

### What an interviewer is really asking

"What happens when the AI re-runs and the user already edited the output?" tests whether you anticipate the regeneration-vs-edit conflict before it becomes a support ticket. The senior signal is naming the marker, the reconciliation policy, and the fact that the lock must ship *with* the edit feature — and, for this codebase, honestly stating it does not yet apply because the data is read-only.

### Likely questions

**[mid] A user edits an AI recommendation, then the investigation re-runs. What should happen, and what does happen here?**

It should preserve the edit — the re-run should skip human-owned fields. In blooming insights it does not arise: recommendations are read-only (`lib/mcp/types.ts` L58–L66 has no edit metadata; the UI only renders and exports). To support editing safely you would add an `_overridden_at` marker and check it on re-run.

```
edit → _overridden_at=now() → re-run sees it → SKIP → edit preserved
```

**[senior] Why isn't "last write wins" good enough?**

Because the re-run is automated and frequent, so last-write-wins almost always means the *machine* writes last and erases the human's edit — a silent loss the user did not consent to. The marker breaks the symmetry: a human edit is flagged, so the re-run defers to it. The user, not the clock, wins.

```
no marker: re-run writes last → user edit gone (silent)
marker:    re-run sees _overridden_at → keeps user edit
```

**[arch] Where does the marker live and how granular should it be?**

On the persisted record (`lib/mcp/types.ts` `Recommendation`, plus a merge step in `lib/state/`). A whole-record timestamp is simplest but locks every field on one edit; field-level (`_overridden_fields`) lets the machine refresh untouched fields. Add a `generatedAt` on fresh output and you can do newest-wins for genuinely stale edits. Start record-level, upgrade to field-level when partial refresh matters.

```
record-level: 1 timestamp, edit locks all fields  (simple)
field-level:  _overridden_fields[], partial refresh (granular)
```

### The question candidates always dodge

**"What about a dismissed item — is that an override?"** Yes, and it is the one people forget. A dismissal is a human decision exactly like an edit; if the marker design does not treat `_dismissed` as an override, the re-run regenerates the dismissed recommendation and it reappears every time. Naming dismissal as a form of override is the signal you have thought it through.

### One-line anchors

- `lib/mcp/types.ts` L58–L66 — `Recommendation`: machine fields only, no override metadata (confirms Case B).
- `lib/state/insights.ts` L24–L49 — machine-only writes, no edit/patch path.
- `app/investigate/[id]/page.tsx` L253–L264 — read-only render + export, no edit control.
- `_overridden_at` marker + a merge check = user-wins reconciliation.
- The lock ships *with* the edit feature; a dismissal is an override too.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the two-writer conflict (machine re-run vs. human edit on one field) and the marker that resolves it. State the field name (`_overridden_at`), where it lives (the record), and the re-run's check (skip if set).

### Level 2 — Explain

Out loud: why does "last write wins" structurally favor the machine over the human here? Why is a dismissal an override that the marker design must cover?

### Level 3 — Apply

Scenario: a PM asks for dismissible recommendations. Open `lib/mcp/types.ts` L58–L66 and `lib/state/insights.ts` L24–L49 — name exactly which type gains which fields, where the dismiss write sets the marker, and where the re-run's merge check goes. Explain why shipping the dismiss button *without* the marker is a bug.

### Level 4 — Defend

A colleague wants to ship editable recommendations now and "add the override protection later if users complain." Argue why the lock and the edit feature are the same change, what the user-visible failure looks like without it, and which reconciliation policy (user-wins vs. newest-wins) you would ship first.

### Quick check — code reference test

Does the `Recommendation` type carry any field that records a human edit, and what does its absence tell you about this concept's status in the codebase? (Answer: no — `lib/mcp/types.ts` L58–L66 has only machine-generated fields and no `_overridden_at`/`_dismissed`; its absence confirms blooming insights is a read-only analyst, so user-override locks are a buildable target, not a present feature.)
