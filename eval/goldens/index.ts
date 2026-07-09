// eval/goldens/index.ts
//
// Aggregate export of all golden cases. Consumed by eval/run.eval.ts's
// `it.each(goldens)` iteration.
//
// ─── Pattern: golden dataset (the eval's fixed input set) ─────────────────
// This IS the "golden" in the golden-set eval pattern — the curated, version-
// controlled set of cases every harness runs against (run, load, worksheet).
// One case per file (easy to review/diff), collected here into one array.
//
// Order matters — the runner runs cases sequentially, so #1 (the canonical
// happy path) goes first and no-signal cases are interleaved with has-signal
// ones to keep the receipt pattern readable in the summary.

import { goldenCase as case01 } from './01-conversion-drop-mobile-checkout';
import { goldenCase as case02 } from './02-fraud-payment-failure-credit-card';
import { goldenCase as case03 } from './03-session-drop-organic-mobile';
import { goldenCase as case04 } from './04-cart-abandonment-mobile-broad';
import { goldenCase as case05 } from './05-no-signal-retention-subscribers';
import { goldenCase as case06 } from './06-no-signal-price-sensitivity-luxury';
import { goldenCase as case07 } from './07-positive-conversion-surge-mobile';
import { goldenCase as case08 } from './08-checkout-collapse-multi-scope';
import { goldenCase as case09 } from './09-engagement-drop-email-campaign';
import { goldenCase as case10 } from './10-no-signal-seo-organic';

import type { GoldenCase } from './types';

export const goldens: readonly GoldenCase[] = [
  case01,
  case02,
  case03,
  case04,
  case05,
  case06,
  case07,
  case08,
  case09,
  case10,
];

export type { GoldenCase } from './types';
