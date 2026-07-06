# Exercise 02 — audit ONE ground-truth case (eval-first discipline)

## ① verdict

You have 10 golden cases in `eval/goldens/`. Audit one of them the way
someone would audit yours in an interview: **did a human write the
`knownCorrect`, or did AI?** If it was AI, an untrusted label is worse
than none, because it silently poisons every judge score downstream.

## ② analogy

Writing the exam question and its model answer *before* teaching the
class. If you can't say what a good answer looks like, you don't
understand the feature yet. That's the eval-first discipline. And if
someone else wrote the model answer without telling you, every grade
that comes back is compromised — you don't know what "good" means
anymore.

## ③ in your repo

`eval/goldens/02-fraud-payment-failure-credit-card.ts` — pick this one. It
already exists on disk. The shape lives at `eval/goldens/types.ts`:

```ts
  // eval/goldens/types.ts:20–38
  export interface GoldenCase {
    caseId: string;
    signalClass: SignalClass;       // has-signal | partial-signal
                                    // | no-signal | positive
    intent: string;                 // free-form: what does this case test?
    anomaly: Anomaly;               // the input to the diagnostic agent
    knownCorrect: Record<string, unknown>; // ← THIS IS THE LABEL
  }
```

The label field is `knownCorrect`. That's the answer key. Look at what
your case 02 says today:

```ts
  // eval/goldens/02-fraud-payment-failure-credit-card.ts:48–58
  knownCorrect: {
    primary_signal:
      'payment_failure_rate up 31.2% on credit_card mobile in the same
       window a mobile checkout conversion drop of 18.4% occurred in SP',
    disambiguation:
      'a real fraud spike would typically show geographic dispersion,
       unusual purchase patterns, or blocklist hits; infrastructure would
       show co-timing with conversion drops and a concentrated scope
       (credit_card + mobile) — the evidence favors infrastructure',
    scope_should_stay_within: ['credit_card', 'mobile'],
    red_herrings_to_avoid: [
      'blaming the customer segment when infra is more consistent…',
      'conflating fraud category tag with root cause without disambiguating',
    ],
  },
```

That is a specific, opinionated, domain-tied answer key. Someone who knew
Bloomreach ecommerce, thought about what a strong diagnosis looks like,
and wrote out *what would separate a 5 from a 3* on this case. That is
the human authoring you're auditing.

## ④ human track — what only you can author

Read case 02's `knownCorrect` line by line. For each field, ask:

- **`primary_signal`** — did I write this, or did I let AI infer it from the anomaly? This one has specific numbers (31.2%, 18.4%) that trace back to the anomaly's evidence. If AI generated it, it would probably be vaguer ("payment failures went up"). The specificity is the human signature.
- **`disambiguation`** — this is the load-bearing field. "The evidence favors infrastructure" is a domain judgment, not a mechanical inference. Only a human who understands Bloomreach's fraud vs infra failure modes can write that. If AI wrote it, it would hedge ("could be either").
- **`scope_should_stay_within`** — narrow. Human wrote it because they knew what "scope drift" costs on this specific case.
- **`red_herrings_to_avoid`** — the strongest human-authored signal, because it names what a *wrong* diagnosis would look like. That's what someone with taste writes; the AI's default is to describe correctness, not to name the failure modes.

**The reader authors the answer key.** Non-negotiable. If you can't write
`knownCorrect` for a case, you don't understand the feature well enough to
grade it yet, and no eval built on that case is meaningful.

## ⑤ AI track — what Claude may draft and how it's verified

- **Candidate anomalies**: "Draft me 5 realistic Bloomreach ecommerce anomalies that would exercise different failure modes." Claude is good at this — enumeration and shape. The `anomaly` object in a golden case can come from Claude.
- **Candidate `intent` copy**: "Given this anomaly, what would a strong `intent` field say about what this case tests?" Draft acceptable; you sign off.
- **NEVER `knownCorrect`**: this is the ground truth. Claude does not know what a strong diagnosis looks like for *your* domain. Every field in `knownCorrect` is human judgment.

Verification: read `knownCorrect` next to the anomaly. If you can defend
each phrase — "yes, that IS the red herring; yes, that IS the primary
signal" — you own it. If any phrase makes you hesitate, either you didn't
write it or you don't stand behind it. Both mean rewrite.

## ⑥ do it

1. Open `eval/goldens/02-fraud-payment-failure-credit-card.ts`. Read the whole file.
2. Read the `anomaly` block, then read `knownCorrect`. Ask: *if I dropped this case in front of the diagnostic agent tomorrow, could I defend every phrase in `knownCorrect` as MY judgment about what a strong diagnosis looks like?*
3. Pick the one line in `knownCorrect` that carries the most weight. (The coach's read: `red_herrings_to_avoid[0]` — "blaming the customer segment when infra is more consistent with the pattern." That's a domain call, not an inference.)
4. Do the same audit on case 08 (`08-checkout-collapse-multi-scope.ts`) — the one Move 3's fingerprint anchored to. Case 08 is the one that failed at the interview-critical dim in the baseline; its `knownCorrect` had better be defensible.
5. If any golden fails the audit (`knownCorrect` was AI-generated and never verified), tag it and rewrite it as its own follow-up work. An untrusted label is worse than no label.

## ⑦ done when

- You've read `eval/goldens/02-*.ts` and can defend every field in `knownCorrect` as a human judgment you'd sign your name to.
- You can name the load-bearing field in a golden case (`knownCorrect`) and why AI cannot author it (no signal below it to catch its mistake — same rule as Exercise 01).
- You have a plan for any golden whose `knownCorrect` you can't defend: rewrite it or drop it. Don't leave untrusted labels in the eval.
